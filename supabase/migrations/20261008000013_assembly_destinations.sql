-- Destino ao concluir uma montagem aprovada: liberado para bloqueio ou liberado para laudo.
-- Rode depois de 20261008000012_resale_only_montagem.sql. Pode rodar de novo.

alter table public.devices drop constraint if exists devices_destination_check;
alter table public.devices
  add constraint devices_destination_check
  check (destination in ('montagem', 'vidro', 'analise', 'bloqueio', 'laudo'));

-- Análise da montagem: acrescenta os liberados por destino (cada serial conta uma vez).
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
           d.asset_short_id, d.source_device_id, d.user_id, d.concluded_at, d.destination
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
        'parts', r.parts
      ) order by r.concluded_at desc)
      from (
        select b.asset_short_id, b.serial, b.failed_items, b.concluded_at,
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
