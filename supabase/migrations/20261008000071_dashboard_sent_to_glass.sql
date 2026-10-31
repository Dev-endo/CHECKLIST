-- Aba Análise > Colaborador: quantos aparelhos cada um liberou para o vidro (além da quarentena).
-- Rode depois de 20261008000070_dashboard.sql. Pode rodar de novo.
--
-- "Liberou para o vidro" = aparelhos (por serial) que a pessoa mandou para o vidro: fim do Estágio 1, fim da manutenção
-- ou fim do reparo em placa. "Vidros" continua sendo o vidro feito pelo técnico de vidro.

drop function if exists public.repair_dashboard_people(date, date);

create or replace function public.repair_dashboard_people(p_from date, p_to date)
returns table (user_id uuid, name text, manutencoes bigint, quarentena bigint, vidro_enviados bigint, placas bigint, vidros bigint)
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
    select st.technician_id as uid, sum(st.maintenance_count)::bigint as n
      from public.repair_stages st, w
     where st.stage = 'manutencao' and st.status = 'concluida' and st.finished_at >= w.t0 and st.finished_at < w.t1
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
    select uid from m union select uid from qq union select uid from vs union select uid from pl union select uid from vd
  )
  select ids.uid, coalesce(nullif(btrim(p.name), ''), p.email),
         coalesce(m.n, 0), coalesce(qq.n, 0), coalesce(vs.n, 0), coalesce(pl.n, 0), coalesce(vd.n, 0)
  from ids
  join public.profiles p on p.id = ids.uid
  left join m on m.uid = ids.uid
  left join qq on qq.uid = ids.uid
  left join vs on vs.uid = ids.uid
  left join pl on pl.uid = ids.uid
  left join vd on vd.uid = ids.uid
  where ids.uid is not null
    and (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by 2;
$$;

drop function if exists public.repair_dashboard_person_daily(uuid, date, date);

create or replace function public.repair_dashboard_person_daily(p_user uuid, p_from date, p_to date)
returns table (day date, manutencoes bigint, quarentena bigint, vidro_enviados bigint, placas bigint, vidros bigint)
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
    select (st.finished_at at time zone 'America/Sao_Paulo')::date as d, sum(st.maintenance_count)::bigint as n
      from public.repair_stages st, w
     where st.technician_id = p_user and st.stage = 'manutencao' and st.status = 'concluida'
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
  days as (
    select d from m union select d from qq union select d from vs union select d from pl union select d from vd
  )
  select days.d, coalesce(m.n, 0), coalesce(qq.n, 0), coalesce(vs.n, 0), coalesce(pl.n, 0), coalesce(vd.n, 0)
  from days
  left join m on m.d = days.d
  left join qq on qq.d = days.d
  left join vs on vs.d = days.d
  left join pl on pl.d = days.d
  left join vd on vd.d = days.d
  where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by 1 desc;
$$;

revoke all on function public.repair_dashboard_people(date, date) from public, anon;
revoke all on function public.repair_dashboard_person_daily(uuid, date, date) from public, anon;
grant execute on function public.repair_dashboard_people(date, date) to authenticated;
grant execute on function public.repair_dashboard_person_daily(uuid, date, date) to authenticated;
