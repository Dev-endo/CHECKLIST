-- Reprovar na montagem: observação, e direcionamento (análise técnica ou retorno para manutenção).
-- Rode depois de 20261008000013_assembly_destinations.sql. Pode rodar de novo.

alter table public.devices
  add column if not exists notes text check (char_length(notes) <= 500);

alter table public.devices drop constraint if exists devices_destination_check;
alter table public.devices
  add constraint devices_destination_check
  check (destination in ('montagem', 'vidro', 'analise', 'bloqueio', 'laudo', 'manutencao'));

-- Manutenção: "enviados para análise técnica" passa a contar também os enviados pela montagem
-- (cada serial uma vez, somando os dois checklists).
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

-- Montagem: acrescenta os que voltaram para a manutenção e o direcionamento/observação nas reprovações.
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
  parts as (
    select b.id, f ->> 'item' as part
    from base b, jsonb_array_elements(b.faulty_parts) as f
    where b.status = 'reprovado'
  )
  select jsonb_build_object(
    'checklists', (select count(*) from base),
    'released', (select count(distinct serial_key) from base where status = 'liberado'),
    'released_block', (select count(distinct serial_key) from base where status = 'liberado' and destination = 'bloqueio'),
    'released_report', (select count(distinct serial_key) from base where status = 'liberado' and destination = 'laudo'),
    'rejected', (select count(*) from base where status = 'reprovado'),
    'returned_maintenance', (select count(distinct serial_key) from base
                              where status = 'reprovado' and destination = 'manutencao'),
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
