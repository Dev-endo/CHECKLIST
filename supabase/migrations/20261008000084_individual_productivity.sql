-- Aba Análise > Produtividade individual: por dia, cada técnico com "Meta batida" ou "Meta não batida", a
-- justificativa, os aparelhos que ele fez e as manutenções.
-- Rode depois de 20261008000083_maintenance_visibility.sql. Pode rodar de novo.
--
-- Meta (migration 82): 6 aparelhos liberados no dia para a quarentena e para o vidro. Aparecem todos os técnicos
-- (papel Técnico) e quem mais tiver liberado, finalizado manutenção ou justificado a meta no dia.

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
     where st.stage = 'manutencao' and st.status = 'concluida' and st.finished_at >= w.t0 and st.finished_at < w.t1
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

-- Os aparelhos que a pessoa fez no dia: manutenções finalizadas (Estágio 2 / Checklist manutenção), fim do
-- Estágio 1 direto para o vidro ou a análise técnica e reparo em placa enviado para a quarentena.
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
     where st.technician_id = p_user and st.stage = 'manutencao' and st.status = 'concluida'
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

revoke all on function public.repair_productivity(date) from public, anon;
revoke all on function public.repair_productivity_devices(uuid, date) from public, anon;
grant execute on function public.repair_productivity(date) to authenticated;
grant execute on function public.repair_productivity_devices(uuid, date) to authenticated;
