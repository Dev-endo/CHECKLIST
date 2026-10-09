-- "Liberado para montagem" é do aparelho (serial), pelo ÚLTIMO checklist concluído dele:
-- se quem fechou por último reprovar, o aparelho deixa de estar liberado.
-- Rode depois de 20261008000002_maintenances.sql.

create index if not exists devices_concluded_serial_idx
  on public.devices (lower(btrim(serial)), concluded_at desc)
  where phase = 'concluido';

-- Dos checklists informados, diz quais são o último concluído do seu serial e estão liberados.
-- SECURITY DEFINER para comparar com checklists de outras pessoas (um colaborador só vê os
-- próprios), mas devolve apenas um sim/não, e só dos checklists que o chamador já pode ler.
create function public.release_flags(p_ids uuid[])
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
      and (d.user_id = (select auth.uid()) or (select public.current_user_role()) in ('admin', 'supervisor'))
  ),
  latest as (
    select distinct on (lower(btrim(d.serial))) lower(btrim(d.serial)) as serial_key, d.id, d.status
    from public.devices d
    where d.phase = 'concluido'
      and lower(btrim(d.serial)) in (select serial_key from mine)
    order by lower(btrim(d.serial)), d.concluded_at desc
  )
  select m.id, coalesce(l.id = m.id and l.status = 'liberado', false)
  from mine m
  left join latest l on l.serial_key = m.serial_key;
$$;

revoke all on function public.release_flags(uuid[]) from public, anon;
grant execute on function public.release_flags(uuid[]) to authenticated;

-- Análise: ativo liberado = o último checklist concluído do serial NO PERÍODO está liberado.
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
    select lower(btrim(d.serial)) as serial_key, d.status, d.maintenances, d.concluded_at
    from public.devices d
    where d.phase = 'concluido'
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
