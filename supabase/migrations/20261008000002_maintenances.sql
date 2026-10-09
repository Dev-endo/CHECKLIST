-- Manutenções informadas ao concluir um checklist liberado, e o relatório para supervisores.

-- [{ "item": "Placa", "detail": "..." }, { "item": "Limpeza" }]
alter table public.devices
  add column maintenances jsonb not null default '[]'::jsonb
  check (jsonb_typeof(maintenances) = 'array' and jsonb_array_length(maintenances) <= 40);

-- Resumo no período (pela data de conclusão). Cada serial conta como um ativo.
-- SECURITY INVOKER: a RLS decide o que cada um enxerga (supervisor e admin veem todos).
create function public.maintenance_report(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_user uuid default null
) returns jsonb
language sql
stable
set search_path = ''
as $$
  with base as (
    select lower(btrim(d.serial)) as serial_key, d.status, d.maintenances
    from public.devices d
    where d.phase = 'concluido'
      and (p_from is null or d.concluded_at >= p_from)
      and (p_to is null or d.concluded_at < p_to)
      and (p_user is null or d.user_id = p_user)
  ),
  items as (
    select b.serial_key, m ->> 'item' as item, m ->> 'detail' as detail
    from base b, jsonb_array_elements(b.maintenances) as m
  )
  select jsonb_build_object(
    'checklists', (select count(*) from base),
    'assets_released', (select count(distinct serial_key) from base where status = 'liberado'),
    'assets_with_maintenance', (select count(distinct serial_key) from items),
    'maintenances_total', (select count(*) from items),
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

revoke all on function public.maintenance_report(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.maintenance_report(timestamptz, timestamptz, uuid) to authenticated;
