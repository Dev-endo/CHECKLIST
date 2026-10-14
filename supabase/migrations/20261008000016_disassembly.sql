-- Desmontagem e desmontagem técnica, ativo bloqueado e destino PT.
-- Rode depois de 20261008000015_quarantine.sql. Pode rodar de novo.

alter table public.devices
  add column if not exists blocked boolean not null default false,
  add column if not exists high_lid boolean,
  add column if not exists boot_issue text check (boot_issue in ('nao_liga', 'looping'));

alter table public.devices drop constraint if exists devices_kind_check;
alter table public.devices
  add constraint devices_kind_check
  check (kind in ('manutencao', 'montagem', 'desmontagem', 'desmontagem_tecnica'));

alter table public.devices drop constraint if exists devices_destination_check;
alter table public.devices
  add constraint devices_destination_check
  check (destination in ('montagem', 'vidro', 'analise', 'bloqueio', 'quarentena', 'manutencao', 'pt'));

-- Manutenção e as duas desmontagens: técnico (e admin). Montagem: montador (e admin).
-- Sempre o dono, e só enquanto pendente.
drop policy if exists "devices_insert_own" on public.devices;
create policy "devices_insert_own" on public.devices
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and phase = 'pendente'
    and (
      (kind in ('manutencao', 'desmontagem', 'desmontagem_tecnica')
        and (select public.current_user_role()) in ('tecnico', 'admin'))
      or (kind = 'montagem' and (select public.current_user_role()) in ('montador', 'admin'))
    )
  );

drop policy if exists "devices_update_own_pending" on public.devices;
create policy "devices_update_own_pending" on public.devices
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and phase = 'pendente'
    and (
      (kind in ('manutencao', 'desmontagem', 'desmontagem_tecnica')
        and (select public.current_user_role()) in ('tecnico', 'admin'))
      or (kind = 'montagem' and (select public.current_user_role()) in ('montador', 'admin'))
    )
  )
  with check (user_id = (select auth.uid()));

-- Último checklist concluído do serial entre manutenção e desmontagens: diz de onde o aparelho vem.
-- A montagem libera o aparelho se foi enviado para montagem (a desmontagem vale pelo destino escolhido).
-- SECURITY DEFINER porque o montador não lê os checklists dos técnicos.
drop function if exists public.assembly_source(text);
create function public.assembly_source(p_serial text)
returns table (
  device_id uuid, kind text, destination text, status public.device_status, technician text, concluded_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.kind, d.destination, d.status, coalesce(nullif(btrim(p.name), ''), p.email), d.concluded_at
  from public.devices d
  join public.profiles p on p.id = d.user_id
  where d.kind in ('manutencao', 'desmontagem', 'desmontagem_tecnica')
    and d.phase = 'concluido'
    and lower(btrim(d.serial)) = lower(btrim(p_serial))
    and (select public.current_user_role()) in ('admin', 'supervisor', 'montador')
  order by d.concluded_at desc
  limit 1;
$$;

revoke all on function public.assembly_source(text) from public, anon;
grant execute on function public.assembly_source(text) to authenticated;

-- Manutenção: acrescenta os enviados para PT (cada serial uma vez, em qualquer checklist).
create or replace function public.maintenance_report(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_user uuid default null
) returns jsonb
language sql
stable
set search_path = ''
as $$
  with base as (
    select lower(btrim(d.serial)) as serial_key, d.status, d.maintenances, d.concluded_at,
           d.user_id, d.destination, d.results
    from public.devices d
    where d.kind = 'manutencao'
      and d.phase = 'concluido'
      and (p_from is null or d.concluded_at >= p_from)
      and (p_to is null or d.concluded_at < p_to)
      and (p_user is null or d.user_id = p_user)
  ),
  last_per_asset as (
    select distinct on (serial_key) serial_key, status
    from base
    order by serial_key, concluded_at desc
  ),
  items as (
    select b.serial_key, m ->> 'item' as item, m ->> 'detail' as detail
    from base b, jsonb_array_elements(b.maintenances) as m
  )
  select jsonb_build_object(
    'checklists', (select count(*) from base),
    'assets_released', (select count(*) from last_per_asset where status = 'liberado'),
    'assets_not_released', (select count(*) from last_per_asset where status <> 'liberado'),
    'released_assembly', (select count(*) from base where status = 'liberado' and destination = 'montagem'),
    'released_glass', (select count(*) from base where status = 'liberado' and destination = 'vidro'),
    'released_resale', (select count(*) from base
                         where status = 'liberado' and destination = 'montagem' and results ->> 'faceid' = 'fail'),
    'sent_analysis', (select count(distinct lower(btrim(a.serial)))
                      from public.devices a
                      where a.phase = 'concluido'
                        and a.destination = 'analise'
                        and (p_from is null or a.concluded_at >= p_from)
                        and (p_to is null or a.concluded_at < p_to)
                        and (p_user is null or a.user_id = p_user)),
    'sent_pt', (select count(distinct lower(btrim(a.serial)))
                from public.devices a
                where a.phase = 'concluido'
                  and a.destination = 'pt'
                  and (p_from is null or a.concluded_at >= p_from)
                  and (p_to is null or a.concluded_at < p_to)
                  and (p_user is null or a.user_id = p_user)),
    'assets_with_maintenance', (select count(distinct serial_key) from items),
    'maintenances_total', (select count(*) from items),
    'by_technician', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', name, 'assembly', assembly, 'glass', glass, 'rejected', rejected
      ) order by assembly desc, glass desc, name)
      from (
        select coalesce(nullif(btrim(p.name), ''), p.email) as name,
               count(*) filter (where b.status = 'liberado' and b.destination = 'montagem') as assembly,
               count(*) filter (where b.status = 'liberado' and b.destination = 'vidro') as glass,
               count(*) filter (where b.status = 'reprovado') as rejected
        from base b
        join public.profiles p on p.id = b.user_id
        group by 1
      ) t
    ), '[]'::jsonb),
    'by_item', coalesce((
      select jsonb_agg(jsonb_build_object('item', item, 'count', n, 'assets', a) order by n desc, item)
      from (select item, count(*) as n, count(distinct serial_key) as a from items group by item) t
    ), '[]'::jsonb),
    'placa_details', coalesce((
      select jsonb_agg(jsonb_build_object('detail', detail, 'count', n) order by n desc, detail)
      from (
        select coalesce(nullif(btrim(detail), ''), 'Não informado') as detail, count(*) as n
        from items where item = 'Placa' group by 1
      ) t
    ), '[]'::jsonb)
  );
$$;


-- Montagem: bloqueados passam a contar cada serial uma vez, em qualquer etapa.
create or replace function public.assembly_report(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_user uuid default null
) returns jsonb
language sql
stable
set search_path = ''
as $$
  with base as (
    select d.id, lower(btrim(d.serial)) as serial_key, d.serial, d.status, d.faulty_parts, d.failed_items,
           d.asset_short_id, d.source_device_id, d.user_id, d.concluded_at, d.destination, d.notes
    from public.devices d
    where d.kind = 'montagem'
      and d.phase = 'concluido'
      and (p_from is null or d.concluded_at >= p_from)
      and (p_to is null or d.concluded_at < p_to)
      and (p_user is null or d.user_id = p_user)
  ),
  quarantine as (
    select q.result
    from public.quarantine_checks q
    where (p_from is null or q.created_at >= p_from)
      and (p_to is null or q.created_at < p_to)
      and (p_user is null or q.user_id = p_user)
  ),
  parts as (
    select b.id, f ->> 'item' as part
    from base b, jsonb_array_elements(b.faulty_parts) as f
    where b.status = 'reprovado'
  )
  select jsonb_build_object(
    'checklists', (select count(*) from base),
    'released', (select count(distinct serial_key) from base where status = 'liberado'),
    -- Bloqueados: cada serial conta uma vez, não importa se foi marcado na manutenção, na desmontagem
    -- (normal ou técnica) ou enviado para bloqueio pela montagem.
    'released_block', (select count(distinct lower(btrim(a.serial)))
                       from public.devices a
                       where a.phase = 'concluido'
                         and (a.blocked or (a.kind = 'montagem' and a.status = 'liberado' and a.destination = 'bloqueio'))
                         and (p_from is null or a.concluded_at >= p_from)
                         and (p_to is null or a.concluded_at < p_to)
                         and (p_user is null or a.user_id = p_user)),
    'released_quarantine', (select count(distinct serial_key) from base where status = 'liberado' and destination = 'quarentena'),
    'rejected', (select count(*) from base where status = 'reprovado'),
    'returned_maintenance', (select count(distinct serial_key) from base
                              where status = 'reprovado' and destination = 'manutencao'),
    'returned_analysis', (select count(distinct serial_key) from base
                           where status = 'reprovado' and destination = 'analise'),
    'quarantine_approved', (select count(*) from quarantine where result = 'aprovado'),
    'quarantine_rejected', (select count(*) from quarantine where result = 'reprovado'),
    'by_assembler', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'released', released, 'rejected', rejected)
                       order by released desc, rejected desc, name)
      from (
        select coalesce(nullif(btrim(p.name), ''), p.email) as name,
               count(distinct b.serial_key) filter (where b.status = 'liberado') as released,
               count(*) filter (where b.status = 'reprovado') as rejected
        from base b
        join public.profiles p on p.id = b.user_id
        group by 1
      ) t
    ), '[]'::jsonb),
    'by_part', coalesce((
      select jsonb_agg(jsonb_build_object('part', part, 'count', n) order by n desc, part)
      from (select part, count(*) as n from parts group by part) t
    ), '[]'::jsonb),
    'rejections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'unit', r.asset_short_id,
        'serial', r.serial,
        'technician', r.technician,
        'assembler', r.assembler,
        'reasons', to_jsonb(r.failed_items),
        'parts', r.parts,
        'destination', r.destination,
        'note', r.notes
      ) order by r.concluded_at desc)
      from (
        select b.asset_short_id, b.serial, b.failed_items, b.concluded_at, b.destination, b.notes,
               coalesce(nullif(btrim(pa.name), ''), pa.email) as assembler,
               coalesce(nullif(btrim(pt.name), ''), pt.email) as technician,
               coalesce((select jsonb_agg(f ->> 'item') from jsonb_array_elements(b.faulty_parts) as f), '[]'::jsonb) as parts
        from base b
        join public.profiles pa on pa.id = b.user_id
        left join public.devices src on src.id = b.source_device_id
        left join public.profiles pt on pt.id = src.user_id
        where b.status = 'reprovado'
        order by b.concluded_at desc
        limit 200
      ) r
    ), '[]'::jsonb)
  );
$$;
