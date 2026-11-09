-- Meta do dia: 10 aparelhos liberados (era 6). Rode depois de 20261008000092_cleaning_maintenance.sql. Pode rodar de novo.
-- Muda só o número nas duas funções que o usam: a meta de quem está logado e a produtividade da Análise.

-- Corpo da migration 83 com a meta 10.
create or replace function public.repair_my_goal() returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with d as (
    select (now() at time zone 'America/Sao_Paulo')::date as day
  )
  select public.repair_goal_count((select auth.uid()), d.day)
         || jsonb_build_object(
              'meta', 10,
              'justificativa', (select n.note from public.repair_goal_notes n where n.user_id = (select auth.uid()) and n.day = d.day),
              'manutencao', public.repair_person_maintenance((select auth.uid()),
                               d.day::timestamp at time zone 'America/Sao_Paulo',
                               (d.day + 1)::timestamp at time zone 'America/Sao_Paulo'))
  from d;
$$;

revoke all on function public.repair_my_goal() from public, anon;
grant execute on function public.repair_my_goal() to authenticated;

-- Corpo da migration 87 com a meta 10.
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
         (c.goal ->> 'liberados')::integer, (c.goal ->> 'quarentena')::integer, (c.goal ->> 'vidro')::integer, 10,
         (c.goal ->> 'liberados')::integer >= 10,
         (select n.note from public.repair_goal_notes n where n.user_id = c.uid and n.day = p_day),
         (c.maint ->> 'aparelhos')::integer, (c.maint ->> 'manutencoes')::integer, (c.maint ->> 'entregues')::integer,
         (c.maint ->> 'devolvidas')::integer, (c.maint ->> 'substituidas')::integer, (c.maint ->> 'testes_usados')::integer
  from calc c
  join public.profiles p on p.id = c.uid
  where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by 7 desc, 3 desc, 2;
$$;

revoke all on function public.repair_productivity(date) from public, anon;
grant execute on function public.repair_productivity(date) to authenticated;
