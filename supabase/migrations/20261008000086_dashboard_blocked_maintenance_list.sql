-- Aba Análise: balão "Bloqueados", o detalhe das manutenções (quais peças) e a lista de manutenções por técnico.
-- Rode depois de 20261008000085_blocked_destination.sql. Pode rodar de novo.
--
-- * Visão geral: novo balão "Bloqueados" (aparelhos finalizados com destino Bloqueado, com o motivo).
-- * "Reparos feitos": cada aparelho mostra também quais manutenções foram (peças e placa).
-- * Aba Manutenções: ao clicar no técnico, a lista aparelho por aparelho do que ele fez.

-- Texto das manutenções gravadas na etapa: "Bateria, Tela ×2 (teste usada de vez), Placa (descrição)".
create or replace function public.repair_items_text(p_items jsonb) returns text
language sql
immutable
set search_path = ''
as $$
  -- A mesma peça (ex.: a original que ficou e a substituta) aparece uma vez, com a soma.
  with items as (
    select i ->> 'tipo' as tipo, coalesce(i ->> 'peca', 'Peça') as peca, i ->> 'finalidade' as finalidade,
           coalesce((i ->> 'qtd')::integer, 1) as qtd, nullif(btrim(i ->> 'descricao'), '') as descricao
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i
  ),
  grouped as (
    select 1 as ord, 'Placa' || coalesce(' (' || descricao || ')', '') as txt from items where tipo = 'placa'
    union all
    select 2, peca || case when sum(qtd) > 1 then ' ×' || sum(qtd) else '' end
              || case when finalidade = 'teste' then ' (teste usada de vez)' else '' end
      from items where tipo is distinct from 'placa'
     group by peca, finalidade
  )
  select nullif(string_agg(txt, ', ' order by ord, txt), '') from grouped;
$$;

create or replace function public.repair_dashboard_devices(p_kind text, p_from date, p_to date)
returns table (serial text, os_number text, model text, person text, at timestamptz, detail text)
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select (p_from::timestamp at time zone 'America/Sao_Paulo') as t0,
           ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo') as t1
  ),
  ev as (
    select s.serial, s.os_number, s.sender_id as person_id, s.sent_at as at, null::text as detail
      from public.repair_quarantine_sends() s, w
     where p_kind = 'quarentena' and s.sent_at >= w.t0 and s.sent_at < w.t1
    union all
    select g.serial, o.os_number, g.requested_by, g.created_at,
           case g.origin when 'avaliacao' then 'Do Estágio 1' when 'manutencao' then 'Do Estágio 2' else 'Do reparo em placa' end
      from public.repair_glass_jobs g
      join public.service_orders o on o.id = g.os_id, w
     where p_kind = 'vidro' and g.created_at >= w.t0 and g.created_at < w.t1
    union all
    select st.serial, o.os_number, e.actor, e.created_at,
           case e.action when 'avaliacao_concluida' then 'Do Estágio 1' else 'Manutenção reprovada' end
      from public.repair_events e
      join public.repair_stages st on st.id = e.stage_id
      join public.service_orders o on o.id = st.os_id, w
     where p_kind = 'analise'
       and e.action in ('avaliacao_concluida', 'manutencao_finalizada')
       and e.detail ->> 'destino' = 'analise'
       and e.created_at >= w.t0 and e.created_at < w.t1
    union all
    select st.serial, o.os_number, st.technician_id, st.finished_at,
           st.maintenance_count::text || case when st.maintenance_count = 1 then ' manutenção' else ' manutenções' end
             || coalesce(': ' || public.repair_items_text(st.maintenance_items), '')
      from public.repair_stages st
      join public.service_orders o on o.id = st.os_id, w
     where p_kind = 'reparos' and st.stage = 'manutencao' and st.status = 'concluida' and st.maintenance_count > 0
       and st.finished_at >= w.t0 and st.finished_at < w.t1
    union all
    select st.serial, o.os_number, st.technician_id, st.finished_at,
           coalesce('Motivo: ' || nullif(btrim(st.resale_reason), ''), null)
      from public.repair_stages st
      join public.service_orders o on o.id = st.os_id, w
     where p_kind = 'bloqueados' and st.stage = 'manutencao' and st.status = 'concluida' and st.outcome = 'bloqueado'
       and st.finished_at >= w.t0 and st.finished_at < w.t1
    union all
    select q.serial,
           (select o.os_number from public.service_orders o
             where o.serial_key = lower(btrim(q.serial)) and o.created_at <= q.created_at
             order by o.created_at desc limit 1),
           q.user_id, q.created_at, null::text
      from public.quarantine_checks q, w
     where p_kind in ('aprovados', 'reprovados')
       and q.result = case p_kind when 'aprovados' then 'aprovado' else 'reprovado' end
       and q.created_at >= w.t0 and q.created_at < w.t1
  )
  select ev.serial, ev.os_number, a.model, coalesce(nullif(btrim(p.name), ''), p.email), ev.at, ev.detail
  from ev
  left join public.profiles p on p.id = ev.person_id
  left join public.assets a on a.serial_key = lower(btrim(ev.serial))
  where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by ev.at desc
  limit 2000;
$$;

create or replace function public.repair_dashboard_summary(p_from date, p_to date) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'quarentena', (select count(distinct lower(btrim(d.serial))) from public.repair_dashboard_devices('quarentena', p_from, p_to) d),
    'vidro', (select count(distinct lower(btrim(d.serial))) from public.repair_dashboard_devices('vidro', p_from, p_to) d),
    'analise', (select count(distinct lower(btrim(d.serial))) from public.repair_dashboard_devices('analise', p_from, p_to) d),
    'reparos_aparelhos', (select count(distinct lower(btrim(d.serial))) from public.repair_dashboard_devices('reparos', p_from, p_to) d),
    'reparos', (select coalesce(sum(st.maintenance_count), 0) from public.repair_stages st
                 where st.stage = 'manutencao' and st.status = 'concluida'
                   and st.finished_at >= (p_from::timestamp at time zone 'America/Sao_Paulo')
                   and st.finished_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo')),
    'bloqueados', (select count(distinct lower(btrim(d.serial))) from public.repair_dashboard_devices('bloqueados', p_from, p_to) d),
    'aprovados', (select count(distinct lower(btrim(d.serial))) from public.repair_dashboard_devices('aprovados', p_from, p_to) d),
    'reprovados', (select count(distinct lower(btrim(d.serial))) from public.repair_dashboard_devices('reprovados', p_from, p_to) d)
  )
  where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]));
$$;

-- Manutenções aparelho por aparelho (aba Manutenções, ao clicar no técnico).
create or replace function public.repair_dashboard_maintenance_devices(p_user uuid, p_from date, p_to date)
returns table (at timestamptz, serial text, model text, unit text, os_number text, origem text, destino text, manutencoes integer,
               itens text, entregues integer, devolvidas integer, substituidas integer)
language sql
stable
security definer
set search_path = ''
as $$
  select st.finished_at, st.serial, a.model, a.asset_short_id, o.os_number,
         case when st.legacy then 'Checklist manutenção' else 'Estágio 2' end,
         st.outcome, st.maintenance_count, public.repair_items_text(st.maintenance_items),
         (f ->> 'entregues')::integer, (f ->> 'devolvidas')::integer, (f ->> 'substituidas')::integer
  from public.repair_stages st
  cross join lateral (select public.repair_stage_parts_flow(st.id) as f) flow
  left join public.service_orders o on o.id = st.os_id
  left join public.assets a on a.serial_key = st.serial_key
  where st.technician_id = p_user and st.stage = 'manutencao' and st.status = 'concluida'
    and st.finished_at >= (p_from::timestamp at time zone 'America/Sao_Paulo')
    and st.finished_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    and (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by st.finished_at desc
  limit 1000;
$$;

revoke all on function public.repair_items_text(jsonb) from public, anon;
grant execute on function public.repair_items_text(jsonb) to authenticated;
revoke all on function public.repair_dashboard_devices(text, date, date) from public, anon;
revoke all on function public.repair_dashboard_summary(date, date) from public, anon;
revoke all on function public.repair_dashboard_maintenance_devices(uuid, date, date) from public, anon;
grant execute on function public.repair_dashboard_devices(text, date, date) to authenticated;
grant execute on function public.repair_dashboard_summary(date, date) to authenticated;
grant execute on function public.repair_dashboard_maintenance_devices(uuid, date, date) to authenticated;
