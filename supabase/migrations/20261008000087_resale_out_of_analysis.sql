-- Revenda fora da Análise e da meta.
-- Rode depois de 20261008000086_dashboard_blocked_maintenance_list.sql. Pode rodar de novo.
--
-- Aparelho liberado para Revenda não conta em nada da Análise (Colaborador, Produtividade individual, Manutenções,
-- "Reparos feitos") nem no quadro da meta do técnico: quem só liberou revenda no dia não aparece na lista. A meta já
-- contava só quarentena e vidro. O resto (quarentena, vidro, análise técnica, PT, bloqueado) continua igual.

-- repair_dashboard_people: mesmo corpo da migration 82, sem a revenda.
create or replace function public.repair_dashboard_people(p_from date, p_to date)
returns table (user_id uuid, name text, manutencoes bigint, testes_usados bigint, quarentena bigint, vidro_enviados bigint,
               analise_enviados bigint, placas bigint, vidros bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select (p_from::timestamp at time zone 'America/Sao_Paulo') as t0,
           ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo') as t1
  ),
  m as (
    select st.technician_id as uid, sum(st.maintenance_count)::bigint as n,
           sum((select coalesce(sum(coalesce((i ->> 'qtd')::integer, 1)), 0) from jsonb_array_elements(st.maintenance_items) i
                 where i ->> 'finalidade' = 'teste'))::bigint as t
      from public.repair_stages st, w
     where st.stage = 'manutencao' and st.status = 'concluida' and st.outcome is distinct from 'revenda' and st.finished_at >= w.t0 and st.finished_at < w.t1
     group by 1
  ),
  qq as (
    select s.sender_id as uid, count(distinct s.serial_key)::bigint as n
      from public.repair_quarantine_sends() s, w
     where s.sent_at >= w.t0 and s.sent_at < w.t1
     group by 1
  ),
  vs as (
    select g.requested_by as uid, count(distinct g.serial_key)::bigint as n
      from public.repair_glass_jobs g, w
     where g.created_at >= w.t0 and g.created_at < w.t1
     group by 1
  ),
  an as (
    select e.actor as uid, count(distinct st.serial_key)::bigint as n
      from public.repair_events e
      join public.repair_stages st on st.id = e.stage_id, w
     where e.action in ('avaliacao_concluida', 'manutencao_finalizada') and e.detail ->> 'destino' = 'analise'
       and e.created_at >= w.t0 and e.created_at < w.t1
     group by 1
  ),
  pl as (
    select e.actor as uid, count(*)::bigint as n
      from public.repair_events e, w
     where e.action = 'reparo_placa_concluido' and e.created_at >= w.t0 and e.created_at < w.t1
     group by 1
  ),
  vd as (
    select e.actor as uid, count(*)::bigint as n
      from public.repair_events e, w
     where e.action = 'vidro_concluido' and e.created_at >= w.t0 and e.created_at < w.t1
     group by 1
  ),
  ids as (
    select uid from m union select uid from qq union select uid from vs union select uid from an union select uid from pl union select uid from vd
  )
  select ids.uid, coalesce(nullif(btrim(p.name), ''), p.email),
         coalesce(m.n, 0), coalesce(m.t, 0), coalesce(qq.n, 0), coalesce(vs.n, 0), coalesce(an.n, 0), coalesce(pl.n, 0), coalesce(vd.n, 0)
  from ids
  join public.profiles p on p.id = ids.uid
  left join m on m.uid = ids.uid
  left join qq on qq.uid = ids.uid
  left join vs on vs.uid = ids.uid
  left join an on an.uid = ids.uid
  left join pl on pl.uid = ids.uid
  left join vd on vd.uid = ids.uid
  where ids.uid is not null
    and (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by 2;
$$;

-- repair_dashboard_person_daily: mesmo corpo da migration 82, sem a revenda.
create or replace function public.repair_dashboard_person_daily(p_user uuid, p_from date, p_to date)
returns table (day date, manutencoes bigint, testes_usados bigint, quarentena bigint, vidro_enviados bigint,
               analise_enviados bigint, placas bigint, vidros bigint, justificativa text)
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select (p_from::timestamp at time zone 'America/Sao_Paulo') as t0,
           ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo') as t1
  ),
  m as (
    select (st.finished_at at time zone 'America/Sao_Paulo')::date as d, sum(st.maintenance_count)::bigint as n,
           sum((select coalesce(sum(coalesce((i ->> 'qtd')::integer, 1)), 0) from jsonb_array_elements(st.maintenance_items) i
                 where i ->> 'finalidade' = 'teste'))::bigint as t
      from public.repair_stages st, w
     where st.technician_id = p_user and st.stage = 'manutencao' and st.status = 'concluida' and st.outcome is distinct from 'revenda'
       and st.finished_at >= w.t0 and st.finished_at < w.t1
     group by 1
  ),
  qq as (
    select (s.sent_at at time zone 'America/Sao_Paulo')::date as d, count(distinct s.serial_key)::bigint as n
      from public.repair_quarantine_sends() s, w
     where s.sender_id = p_user and s.sent_at >= w.t0 and s.sent_at < w.t1
     group by 1
  ),
  vs as (
    select (g.created_at at time zone 'America/Sao_Paulo')::date as d, count(distinct g.serial_key)::bigint as n
      from public.repair_glass_jobs g, w
     where g.requested_by = p_user and g.created_at >= w.t0 and g.created_at < w.t1
     group by 1
  ),
  an as (
    select (e.created_at at time zone 'America/Sao_Paulo')::date as d, count(distinct st.serial_key)::bigint as n
      from public.repair_events e
      join public.repair_stages st on st.id = e.stage_id, w
     where e.actor = p_user and e.action in ('avaliacao_concluida', 'manutencao_finalizada') and e.detail ->> 'destino' = 'analise'
       and e.created_at >= w.t0 and e.created_at < w.t1
     group by 1
  ),
  pl as (
    select (e.created_at at time zone 'America/Sao_Paulo')::date as d, count(*)::bigint as n
      from public.repair_events e, w
     where e.actor = p_user and e.action = 'reparo_placa_concluido' and e.created_at >= w.t0 and e.created_at < w.t1
     group by 1
  ),
  vd as (
    select (e.created_at at time zone 'America/Sao_Paulo')::date as d, count(*)::bigint as n
      from public.repair_events e, w
     where e.actor = p_user and e.action = 'vidro_concluido' and e.created_at >= w.t0 and e.created_at < w.t1
     group by 1
  ),
  gn as (
    select n.day as d, n.note from public.repair_goal_notes n
     where n.user_id = p_user and n.day between p_from and p_to
  ),
  days as (
    select d from m union select d from qq union select d from vs union select d from an union select d from pl union select d from vd
    union select d from gn
  )
  select days.d, coalesce(m.n, 0), coalesce(m.t, 0), coalesce(qq.n, 0), coalesce(vs.n, 0), coalesce(an.n, 0), coalesce(pl.n, 0),
         coalesce(vd.n, 0), gn.note
  from days
  left join m on m.d = days.d
  left join qq on qq.d = days.d
  left join vs on vs.d = days.d
  left join an on an.d = days.d
  left join pl on pl.d = days.d
  left join vd on vd.d = days.d
  left join gn on gn.d = days.d
  where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by 1 desc;
$$;

-- repair_person_maintenance: mesmo corpo da migration 83, sem a revenda.
create or replace function public.repair_person_maintenance(p_user uuid, p_t0 timestamptz, p_t1 timestamptz) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select st.id, st.maintenance_count, st.maintenance_items, public.repair_stage_parts_flow(st.id) as flow
      from public.repair_stages st
     where st.technician_id = p_user and st.stage = 'manutencao' and st.status = 'concluida' and st.outcome is distinct from 'revenda'
       and st.finished_at >= p_t0 and st.finished_at < p_t1
  )
  select jsonb_build_object(
    'aparelhos', (select count(*) from mine),
    'manutencoes', (select coalesce(sum(maintenance_count), 0) from mine),
    'testes_usados', (select coalesce(sum((select coalesce(sum(coalesce((i ->> 'qtd')::integer, 1)), 0)
                                            from jsonb_array_elements(mine.maintenance_items) i where i ->> 'finalidade' = 'teste')), 0) from mine),
    'entregues', (select coalesce(sum((flow ->> 'entregues')::integer), 0) from mine),
    'substituidas', (select coalesce(sum((flow ->> 'substituidas')::integer), 0) from mine),
    'devolvidas', (select coalesce(sum((flow ->> 'devolvidas')::integer), 0) from mine)
  );
$$;

-- repair_dashboard_maintenance: mesmo corpo da migration 83, sem a revenda.
create or replace function public.repair_dashboard_maintenance(p_from date, p_to date)
returns table (user_id uuid, name text, aparelhos bigint, entregues bigint, devolvidas bigint, substituidas bigint,
               testes_usados bigint, manutencoes bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select (p_from::timestamp at time zone 'America/Sao_Paulo') as t0,
           ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo') as t1
  ),
  techs as (
    select distinct st.technician_id as uid
      from public.repair_stages st, w
     where st.stage = 'manutencao' and st.status = 'concluida' and st.outcome is distinct from 'revenda' and st.finished_at >= w.t0 and st.finished_at < w.t1
  ),
  totals as (
    select t.uid, public.repair_person_maintenance(t.uid, w.t0, w.t1) as j from techs t, w
  )
  select totals.uid, coalesce(nullif(btrim(p.name), ''), p.email),
         (j ->> 'aparelhos')::bigint, (j ->> 'entregues')::bigint, (j ->> 'devolvidas')::bigint,
         (j ->> 'substituidas')::bigint, (j ->> 'testes_usados')::bigint, (j ->> 'manutencoes')::bigint
  from totals
  join public.profiles p on p.id = totals.uid
  where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by 8 desc, 2;
$$;

-- repair_dashboard_maintenance_daily: mesmo corpo da migration 83, sem a revenda.
create or replace function public.repair_dashboard_maintenance_daily(p_user uuid, p_from date, p_to date)
returns table (day date, aparelhos bigint, entregues bigint, devolvidas bigint, substituidas bigint, testes_usados bigint, manutencoes bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with days as (
    select distinct (st.finished_at at time zone 'America/Sao_Paulo')::date as d
      from public.repair_stages st
     where st.technician_id = p_user and st.stage = 'manutencao' and st.status = 'concluida' and st.outcome is distinct from 'revenda'
       and st.finished_at >= (p_from::timestamp at time zone 'America/Sao_Paulo')
       and st.finished_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  ),
  totals as (
    select days.d, public.repair_person_maintenance(p_user, days.d::timestamp at time zone 'America/Sao_Paulo',
                                                     (days.d + 1)::timestamp at time zone 'America/Sao_Paulo') as j
      from days
  )
  select d, (j ->> 'aparelhos')::bigint, (j ->> 'entregues')::bigint, (j ->> 'devolvidas')::bigint,
         (j ->> 'substituidas')::bigint, (j ->> 'testes_usados')::bigint, (j ->> 'manutencoes')::bigint
  from totals
  where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by 1 desc;
$$;

-- repair_productivity: mesmo corpo da migration 84, sem a revenda.
create or replace function public.repair_productivity(p_day date)
returns table (user_id uuid, name text, liberados integer, quarentena integer, vidro integer, meta integer, batida boolean,
               justificativa text, aparelhos integer, manutencoes integer, entregues integer, devolvidas integer, substituidas integer,
               testes_usados integer)
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select (p_day::timestamp at time zone 'America/Sao_Paulo') as t0,
           ((p_day + 1)::timestamp at time zone 'America/Sao_Paulo') as t1
  ),
  people as (
    select p.id from public.profiles p where p.role = 'tecnico' or 'tecnico' = any (coalesce(p.extra_roles, '{}'))
    union
    select s.sender_id from public.repair_quarantine_sends() s, w where s.sent_at >= w.t0 and s.sent_at < w.t1
    union
    select g.requested_by from public.repair_glass_jobs g, w where g.created_at >= w.t0 and g.created_at < w.t1
    union
    select st.technician_id from public.repair_stages st, w
     where st.stage = 'manutencao' and st.status = 'concluida' and st.outcome is distinct from 'revenda' and st.finished_at >= w.t0 and st.finished_at < w.t1
    union
    select n.user_id from public.repair_goal_notes n where n.day = p_day
  ),
  calc as (
    select pe.id as uid,
           public.repair_goal_count(pe.id, p_day) as goal,
           public.repair_person_maintenance(pe.id, w.t0, w.t1) as maint
      from people pe, w
     where pe.id is not null
  )
  select c.uid, coalesce(nullif(btrim(p.name), ''), p.email),
         (c.goal ->> 'liberados')::integer, (c.goal ->> 'quarentena')::integer, (c.goal ->> 'vidro')::integer, 6,
         (c.goal ->> 'liberados')::integer >= 6,
         (select n.note from public.repair_goal_notes n where n.user_id = c.uid and n.day = p_day),
         (c.maint ->> 'aparelhos')::integer, (c.maint ->> 'manutencoes')::integer, (c.maint ->> 'entregues')::integer,
         (c.maint ->> 'devolvidas')::integer, (c.maint ->> 'substituidas')::integer, (c.maint ->> 'testes_usados')::integer
  from calc c
  join public.profiles p on p.id = c.uid
  where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by 7 desc, 3 desc, 2;
$$;

-- repair_productivity_devices: mesmo corpo da migration 84, sem a revenda.
create or replace function public.repair_productivity_devices(p_user uuid, p_day date)
returns table (serial text, model text, unit text, os_number text, origem text, destino text, at timestamptz, manutencoes integer,
               conta_meta boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select (p_day::timestamp at time zone 'America/Sao_Paulo') as t0,
           ((p_day + 1)::timestamp at time zone 'America/Sao_Paulo') as t1
  ),
  done as (
    select st.serial, st.serial_key, st.os_id,
           case when st.legacy then 'Checklist manutenção' else 'Estágio 2' end as origem,
           st.outcome as destino, st.finished_at as at, st.maintenance_count as manutencoes
      from public.repair_stages st, w
     where st.technician_id = p_user and st.stage = 'manutencao' and st.status = 'concluida' and st.outcome is distinct from 'revenda'
       and st.finished_at >= w.t0 and st.finished_at < w.t1
    union all
    select st.serial, st.serial_key, st.os_id, 'Estágio 1', st.destination, st.finished_at, 0
      from public.repair_stages st, w
     where st.technician_id = p_user and st.stage = 'avaliacao' and st.status = 'concluida'
       and st.destination in ('vidro', 'analise')
       and st.finished_at >= w.t0 and st.finished_at < w.t1
    union all
    select q.serial, q.serial_key, q.os_id, 'Reparo em placa', 'quarentena', q.board_finished_at, 0
      from public.repair_analysis_queue q, w
     where q.board_by = p_user and q.board_status = 'concluido' and q.board_destination = 'quarentena' and not q.board_checklist
       and q.board_finished_at >= w.t0 and q.board_finished_at < w.t1
  )
  select d.serial, a.model, a.asset_short_id, o.os_number, d.origem, d.destino, d.at, d.manutencoes,
         d.destino in ('quarentena', 'vidro')
  from done d
  left join public.assets a on a.serial_key = d.serial_key
  left join public.service_orders o on o.id = d.os_id
  where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by d.at;
$$;

-- repair_dashboard_devices: mesmo corpo da migration 86, sem a revenda.
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
     where p_kind = 'reparos' and st.stage = 'manutencao' and st.status = 'concluida' and st.outcome is distinct from 'revenda' and st.maintenance_count > 0
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

-- repair_dashboard_summary: mesmo corpo da migration 86, sem a revenda.
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
                 where st.stage = 'manutencao' and st.status = 'concluida' and st.outcome is distinct from 'revenda'
                   and st.finished_at >= (p_from::timestamp at time zone 'America/Sao_Paulo')
                   and st.finished_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo')),
    'bloqueados', (select count(distinct lower(btrim(d.serial))) from public.repair_dashboard_devices('bloqueados', p_from, p_to) d),
    'aprovados', (select count(distinct lower(btrim(d.serial))) from public.repair_dashboard_devices('aprovados', p_from, p_to) d),
    'reprovados', (select count(distinct lower(btrim(d.serial))) from public.repair_dashboard_devices('reprovados', p_from, p_to) d)
  )
  where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]));
$$;

-- repair_dashboard_maintenance_devices: mesmo corpo da migration 86, sem a revenda.
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
  where st.technician_id = p_user and st.stage = 'manutencao' and st.status = 'concluida' and st.outcome is distinct from 'revenda'
    and st.finished_at >= (p_from::timestamp at time zone 'America/Sao_Paulo')
    and st.finished_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo')
    and (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by st.finished_at desc
  limit 1000;
$$;
