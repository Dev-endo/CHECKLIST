-- Checklist de montagem. Usa a mesma tabela dos checklists de manutenção (kind = 'montagem').
-- Rode depois de 20261008000006_roles_access.sql.

alter table public.devices
  add column kind text not null default 'manutencao' check (kind in ('manutencao', 'montagem')),
  -- Só montagem reprovada: de quem foi o erro e em quais peças.
  add column blame text check (blame in ('montagem', 'manutencao')),
  add column faulty_parts jsonb not null default '[]'::jsonb
    check (jsonb_typeof(faulty_parts) = 'array' and jsonb_array_length(faulty_parts) <= 40),
  -- Checklist de manutenção que liberou o aparelho para esta montagem.
  add column source_device_id uuid references public.devices (id) on delete set null;

create index devices_kind_created_idx on public.devices (kind, created_at desc);

-- kind e user_id nunca mudam depois de criados.
create or replace function public.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := old.created_at;
  new.user_id := old.user_id;
  new.kind := old.kind;
  new.updated_at := now();
  if new.phase = 'concluido' and old.phase = 'pendente' then
    new.concluded_at := now();
  else
    new.concluded_at := old.concluded_at;
  end if;
  return new;
end;
$$;

-- Manutenção: técnico (e admin). Montagem: montador (e admin). Sempre o dono, e só enquanto pendente.
drop policy "devices_insert_own" on public.devices;
create policy "devices_insert_own" on public.devices
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and phase = 'pendente'
    and (
      (kind = 'manutencao' and (select public.current_user_role()) in ('tecnico', 'admin'))
      or (kind = 'montagem' and (select public.current_user_role()) in ('montador', 'admin'))
    )
  );

drop policy "devices_update_own_pending" on public.devices;
create policy "devices_update_own_pending" on public.devices
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and phase = 'pendente'
    and (
      (kind = 'manutencao' and (select public.current_user_role()) in ('tecnico', 'admin'))
      or (kind = 'montagem' and (select public.current_user_role()) in ('montador', 'admin'))
    )
  )
  with check (user_id = (select auth.uid()));

-- Último checklist de MANUTENÇÃO concluído do serial: diz se o aparelho foi liberado para montagem.
-- SECURITY DEFINER porque o montador não lê os checklists dos técnicos.
create function public.assembly_source(p_serial text)
returns table (device_id uuid, destination text, status public.device_status, technician text, concluded_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.destination, d.status, coalesce(nullif(btrim(p.name), ''), p.email), d.concluded_at
  from public.devices d
  join public.profiles p on p.id = d.user_id
  where d.kind = 'manutencao'
    and d.phase = 'concluido'
    and lower(btrim(d.serial)) = lower(btrim(p_serial))
    and (select public.current_user_role()) in ('admin', 'supervisor', 'montador')
  order by d.concluded_at desc
  limit 1;
$$;

revoke all on function public.assembly_source(text) from public, anon;
grant execute on function public.assembly_source(text) to authenticated;

-- Os números da manutenção só contam checklists de manutenção.
create or replace function public.release_flags(p_ids uuid[])
returns table (device_id uuid, released boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select d.id, lower(btrim(d.serial)) as serial_key
    from public.devices d
    where d.id = any (p_ids)
      and d.kind = 'manutencao'
      and (d.user_id = (select auth.uid()) or (select public.current_user_role()) in ('admin', 'supervisor'))
  ),
  latest as (
    select distinct on (lower(btrim(d.serial))) lower(btrim(d.serial)) as serial_key, d.id, d.status
    from public.devices d
    where d.phase = 'concluido'
      and d.kind = 'manutencao'
      and lower(btrim(d.serial)) in (select serial_key from mine)
    order by lower(btrim(d.serial)), d.concluded_at desc
  )
  select m.id, coalesce(l.id = m.id and l.status = 'liberado', false)
  from mine m
  left join latest l on l.serial_key = m.serial_key;
$$;

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
           d.user_id, d.destination
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
    'released_assembly', (select count(distinct serial_key) from base where status = 'liberado' and destination = 'montagem'),
    'released_glass', (select count(distinct serial_key) from base where status = 'liberado' and destination = 'vidro'),
    'assets_with_maintenance', (select count(distinct serial_key) from items),
    'maintenances_total', (select count(*) from items),
    'by_technician', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', name, 'assembly', assembly, 'glass', glass, 'rejected', rejected
      ) order by assembly desc, glass desc, name)
      from (
        select coalesce(nullif(btrim(p.name), ''), p.email) as name,
               count(distinct b.serial_key) filter (where b.status = 'liberado' and b.destination = 'montagem') as assembly,
               count(distinct b.serial_key) filter (where b.status = 'liberado' and b.destination = 'vidro') as glass,
               count(distinct b.serial_key) filter (where b.status = 'reprovado') as rejected
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

-- Análise da montagem no período (pela data de conclusão). p_user filtra por montador.
create function public.assembly_report(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_user uuid default null
) returns jsonb
language sql
stable
set search_path = ''
as $$
  with base as (
    select d.id, lower(btrim(d.serial)) as serial_key, d.status, d.blame, d.faulty_parts,
           d.source_device_id, d.user_id
    from public.devices d
    where d.kind = 'montagem'
      and d.phase = 'concluido'
      and (p_from is null or d.concluded_at >= p_from)
      and (p_to is null or d.concluded_at < p_to)
      and (p_user is null or d.user_id = p_user)
  ),
  parts as (
    select b.serial_key, f ->> 'item' as part
    from base b, jsonb_array_elements(b.faulty_parts) as f
    where b.status = 'reprovado'
  )
  select jsonb_build_object(
    'checklists', (select count(*) from base),
    'released', (select count(distinct serial_key) from base where status = 'liberado'),
    'rejected', (select count(distinct serial_key) from base where status = 'reprovado'),
    'rejected_assembly', (select count(distinct serial_key) from base where status = 'reprovado' and blame = 'montagem'),
    'rejected_maintenance', (select count(distinct serial_key) from base where status = 'reprovado' and blame = 'manutencao'),
    'by_assembler', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'released', released, 'rejected', rejected)
                       order by released desc, name)
      from (
        select coalesce(nullif(btrim(p.name), ''), p.email) as name,
               count(distinct b.serial_key) filter (where b.status = 'liberado') as released,
               count(distinct b.serial_key) filter (where b.status = 'reprovado' and b.blame = 'montagem') as rejected
        from base b
        join public.profiles p on p.id = b.user_id
        group by 1
      ) t
    ), '[]'::jsonb),
    -- Reprovações por culpa da manutenção contam para o técnico que liberou o aparelho.
    'by_technician', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'rejected', rejected) order by rejected desc, name)
      from (
        select coalesce(nullif(btrim(pt.name), ''), pt.email) as name,
               count(distinct b.serial_key) as rejected
        from base b
        join public.devices src on src.id = b.source_device_id
        join public.profiles pt on pt.id = src.user_id
        where b.status = 'reprovado' and b.blame = 'manutencao'
        group by 1
      ) t
    ), '[]'::jsonb),
    'by_part', coalesce((
      select jsonb_agg(jsonb_build_object('part', part, 'count', n) order by n desc, part)
      from (select part, count(*) as n from parts group by part) t
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.assembly_report(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.assembly_report(timestamptz, timestamptz, uuid) to authenticated;
