-- "Enviados para montagem" por serial: cada serial conta 1 se foi enviado (manutenção ou desmontagem);
-- se depois foi reprovado na montagem, diminui 1. Vale o último evento do serial no período.
-- Rode depois de 20261008000031_service_orders.sql. Pode rodar de novo.

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
    'released_assembly', (select count(*) from base where destination = 'montagem'),
    -- Enviados para montagem, por serial: cada serial conta 1 se o último evento dele no período foi um envio
    -- (manutenção ou desmontagem); se depois foi reprovado na montagem, sai da conta.
    'sent_assembly', (select count(*) from (
                        select distinct on (lower(btrim(x.serial))) x.kind
                        from public.devices x
                        where x.phase = 'concluido'
                          and (p_from is null or x.concluded_at >= p_from)
                          and (p_to is null or x.concluded_at < p_to)
                          and ((x.kind in ('manutencao', 'desmontagem', 'desmontagem_tecnica')
                                and x.destination = 'montagem' and (p_user is null or x.user_id = p_user))
                               or (x.kind = 'montagem' and x.status = 'reprovado'))
                        order by lower(btrim(x.serial)), x.concluded_at desc
                      ) e where e.kind <> 'montagem'),
    'released_glass', (select count(*) from base where destination = 'vidro'),
    -- Revenda: marcada pelo técnico; registros antigos, sem a marcação, valem pelo Face ID com defeito.
    'released_resale', (select count(*) from base
                         where destination = 'montagem'
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
    -- Aguardando peça: destino da manutenção (cada serial uma vez).
    'awaiting_part', (select count(distinct serial_key) from base where destination = 'aguardando_peca'),
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
               count(*) filter (where b.destination = 'montagem') as assembly,
               count(*) filter (where b.destination = 'vidro') as glass,
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

drop function if exists public.analysis_devices(text, timestamptz, timestamptz, uuid);

create function public.analysis_devices(
  p_metric text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_user uuid default null
) returns table (
  kind text,
  serial text,
  unit text,
  model text,
  destination text,
  status text,
  technician text,
  concluded_at timestamptz,
  notes text,
  maintenances jsonb,
  parts jsonb,
  failures text[],
  consumption_note text,
  pt_note text
)
language sql
stable
set search_path = ''
as $$
  select * from (
    select d.kind, d.serial, coalesce(d.asset_short_id, a.asset_short_id) as unit, d.model, d.destination,
           d.status::text as status, coalesce(nullif(btrim(p.name), ''), p.email) as technician, d.concluded_at,
           d.notes, d.maintenances, d.faulty_parts as parts, d.failed_items as failures,
           d.consumption_note, d.pt_note
    from public.devices d
    join public.profiles p on p.id = d.user_id
    left join public.assets a on a.serial_key = lower(btrim(d.serial))
    where d.phase = 'concluido'
      and (p_from is null or d.concluded_at >= p_from)
      and (p_to is null or d.concluded_at < p_to)
      and (p_user is null or d.user_id = p_user)
      and case p_metric
        when 'disassembled' then d.kind in ('desmontagem', 'desmontagem_tecnica')
        when 'dis_assembly' then d.kind in ('desmontagem', 'desmontagem_tecnica') and d.destination = 'montagem'
        when 'dis_maintenance' then d.kind in ('desmontagem', 'desmontagem_tecnica') and d.destination = 'manutencao'
        when 'dis_analysis' then d.kind in ('desmontagem', 'desmontagem_tecnica') and d.destination = 'analise'
        when 'dis_pt' then d.kind in ('desmontagem', 'desmontagem_tecnica') and d.destination = 'pt'
        when 'maintenance_items' then d.kind in ('manutencao', 'desmontagem_tecnica') and jsonb_array_length(d.maintenances) > 0
        -- Um aparelho por serial: o último evento dele no período foi um envio para a montagem (não foi
        -- reprovado depois na montagem).
        when 'sent_assembly' then d.id in (
          select e.id from (
            select distinct on (lower(btrim(x.serial))) x.id, x.kind
            from public.devices x
            where x.phase = 'concluido'
              and (p_from is null or x.concluded_at >= p_from)
              and (p_to is null or x.concluded_at < p_to)
              and ((x.kind in ('manutencao', 'desmontagem', 'desmontagem_tecnica')
                    and x.destination = 'montagem' and (p_user is null or x.user_id = p_user))
                   or (x.kind = 'montagem' and x.status = 'reprovado'))
            order by lower(btrim(x.serial)), x.concluded_at desc
          ) e where e.kind <> 'montagem')
        when 'released_assembly' then d.kind = 'manutencao' and d.destination = 'montagem'
        when 'released_glass' then d.kind = 'manutencao' and d.destination = 'vidro'
        when 'awaiting_part' then d.destination = 'aguardando_peca'
        when 'released_resale' then d.kind = 'manutencao' and d.destination = 'montagem'
                                    and coalesce(d.resale, d.results ->> 'faceid' = 'fail')
        when 'sent_analysis' then d.destination = 'analise'
        when 'sent_pt' then d.destination = 'pt'
        when 'blocked' then d.blocked or (d.kind = 'montagem' and d.status = 'liberado' and d.destination = 'bloqueio')
        when 'blocked_maintenance' then d.kind = 'manutencao' and d.blocked
        when 'assembled' then d.kind = 'montagem'
        when 'assembly_approved' then d.kind = 'montagem' and d.status = 'liberado'
        when 'assembly_rejected' then d.kind = 'montagem' and d.status = 'reprovado'
        when 'assembly_analysis' then d.kind = 'montagem' and d.status = 'reprovado' and d.destination = 'analise'
        when 'assembly_maintenance' then d.kind = 'montagem' and d.status = 'reprovado' and d.destination = 'manutencao'
        when 'assembly_quarantine' then d.kind = 'montagem' and d.status = 'liberado' and d.destination = 'quarentena'
        when 'sent_quarantine' then d.destination = 'quarentena'
        when 'all_stages' then true
        else false
      end
    union all
    select 'quarentena', q.serial, coalesce(q.asset_short_id, a.asset_short_id), null::text, null::text,
           q.result, coalesce(nullif(btrim(p.name), ''), p.email), q.created_at,
           null::text, '[]'::jsonb, '[]'::jsonb, '{}'::text[], null::text, null::text
    from public.quarantine_checks q
    join public.profiles p on p.id = q.user_id
    left join public.assets a on a.serial_key = lower(btrim(q.serial))
    where p_metric in ('quarantine_approved', 'quarantine_rejected')
      and q.result = case p_metric when 'quarantine_approved' then 'aprovado' else 'reprovado' end
      and (p_from is null or q.created_at >= p_from)
      and (p_to is null or q.created_at < p_to)
      and (p_user is null or q.user_id = p_user)
  ) t
  order by t.concluded_at desc
  limit 1000;
$$;

revoke all on function public.analysis_devices(text, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.analysis_devices(text, timestamptz, timestamptz, uuid) to authenticated;
