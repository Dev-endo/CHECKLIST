-- Manutenções visíveis na Análise (com o caminho das peças) e para o próprio técnico.
-- Rode depois de 20261008000082_glass_flag_goal.sql. Pode rodar de novo.
--
-- A conta de manutenções não muda (migration 68): cada peça usada de vez conta 1; a peça substituída por defeito
-- sai da conta e a substituta entra no lugar, então substituir não soma. Exemplo: o estoque entrega 10, o técnico
-- devolve 5 de teste, usa 5 de vez e substitui 3 delas: no fim são 5 manutenções.
-- Agora aparecem, por aparelho finalizado (rodada da OS), de onde vem esse número:
--   entregues    = peças entregues pelo estoque, sem contar as substitutas e sem as do vidro;
--   substituidas = peças devolvidas por defeito (trocadas pela substituta);
--   devolvidas   = peças de teste devolvidas ao estoque.

-- Caminho das peças da rodada da etapa (só leitura interna).
create or replace function public.repair_stage_parts_flow(p_stage_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with st as (
    select * from public.repair_stages where id = p_stage_id
  ),
  reqs as (
    select r.* from public.stock_requests r, st
     where r.stage_id in (select x.id from public.repair_stages x where x.os_id = st.os_id and x.round = st.round)
       and not r.glass
  )
  select jsonb_build_object(
    'entregues', (select coalesce(sum(qty_delivered), 0) from reqs where replaces_request_id is null),
    'substituidas', (select coalesce(sum(t.qty), 0) from public.stock_returns t where t.request_id in (select id from reqs) and t.reason = 'substituicao_defeito'),
    'devolvidas', (select coalesce(sum(t.qty), 0) from public.stock_returns t where t.request_id in (select id from reqs) and t.reason = 'devolucao_teste')
  );
$$;

revoke all on function public.repair_stage_parts_flow(uuid) from public, anon, authenticated;

-- Totais de um técnico num intervalo (manutenções finalizadas por ele).
create or replace function public.repair_person_maintenance(p_user uuid, p_t0 timestamptz, p_t1 timestamptz) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select st.id, st.maintenance_count, st.maintenance_items, public.repair_stage_parts_flow(st.id) as flow
      from public.repair_stages st
     where st.technician_id = p_user and st.stage = 'manutencao' and st.status = 'concluida'
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

revoke all on function public.repair_person_maintenance(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- Meta do dia (migration 82) + as manutenções de hoje de quem está logado.
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
              'meta', 6,
              'justificativa', (select n.note from public.repair_goal_notes n where n.user_id = (select auth.uid()) and n.day = d.day),
              'manutencao', public.repair_person_maintenance((select auth.uid()),
                               d.day::timestamp at time zone 'America/Sao_Paulo',
                               (d.day + 1)::timestamp at time zone 'America/Sao_Paulo'))
  from d;
$$;

revoke all on function public.repair_my_goal() from public, anon;
grant execute on function public.repair_my_goal() to authenticated;

-- Análise > Manutenções: por técnico no período e o dia a dia de um técnico.
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
     where st.stage = 'manutencao' and st.status = 'concluida' and st.finished_at >= w.t0 and st.finished_at < w.t1
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
     where st.technician_id = p_user and st.stage = 'manutencao' and st.status = 'concluida'
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

revoke all on function public.repair_dashboard_maintenance(date, date) from public, anon;
revoke all on function public.repair_dashboard_maintenance_daily(uuid, date, date) from public, anon;
grant execute on function public.repair_dashboard_maintenance(date, date) to authenticated;
grant execute on function public.repair_dashboard_maintenance_daily(uuid, date, date) to authenticated;
