-- Revenda escolhida pelo técnico ao concluir a manutenção (sim leva direto para a montagem).
-- Rode depois de 20261008000019_disassembly_numbers.sql. Pode rodar de novo.

alter table public.devices add column if not exists resale boolean;

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
           d.user_id, d.destination, d.results, d.blocked, d.resale
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
  -- Manutenções feitas: as da manutenção e as trocas de peças da desmontagem técnica.
  items as (
    select lower(btrim(d.serial)) as serial_key, m ->> 'item' as item, m ->> 'detail' as detail
    from public.devices d, jsonb_array_elements(d.maintenances) as m
    where d.kind in ('manutencao', 'desmontagem_tecnica')
      and d.phase = 'concluido'
      and (p_from is null or d.concluded_at >= p_from)
      and (p_to is null or d.concluded_at < p_to)
      and (p_user is null or d.user_id = p_user)
  )
  select jsonb_build_object(
    'checklists', (select count(*) from base),
    'assets_released', (select count(*) from last_per_asset where status = 'liberado'),
    'assets_not_released', (select count(*) from last_per_asset where status <> 'liberado'),
    'released_assembly', (select count(*) from base where status = 'liberado' and destination = 'montagem'),
    'released_glass', (select count(*) from base where status = 'liberado' and destination = 'vidro'),
    -- Revenda: marcada pelo técnico; registros antigos, sem a marcação, valem pelo Face ID com defeito.
    'released_resale', (select count(*) from base
                         where status = 'liberado' and destination = 'montagem'
                           and coalesce(resale, results ->> 'faceid' = 'fail')),
    'sent_analysis', (select count(distinct lower(btrim(a.serial)))
                      from public.devices a
                      where a.phase = 'concluido'
                        and a.destination = 'analise'
                        and (p_from is null or a.concluded_at >= p_from)
                        and (p_to is null or a.concluded_at < p_to)
                        and (p_user is null or a.user_id = p_user)),
    -- Desmontagens: cada checklist concluído conta (normal + técnica).
    'disassemblies', (select count(*) from public.devices a
                      where a.kind in ('desmontagem', 'desmontagem_tecnica')
                        and a.phase = 'concluido'
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
    -- Bloqueados identificados na manutenção (cada serial uma vez).
    'blocked_maintenance', (select count(distinct serial_key) from base where blocked),
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
