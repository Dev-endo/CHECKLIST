-- Aba Análise (supervisor e admin): balões, colaboradores (com desempenho diário) e peças.
-- Rode depois de 20261008000069_timer_finish.sql. Pode rodar de novo.
--
-- Período: p_from e p_to são dias (horário de Brasília), os dois incluídos.
-- Balões (contagem por serial, sem repetir):
--   quarentena  aparelhos enviados para a quarentena (manutenção finalizada aprovada);
--   vidro       aparelhos enviados para o vidro (de qualquer estágio);
--   analise     aparelhos enviados para a Análise técnica (fim do Estágio 1 ou manutenção reprovada);
--   reparos     total de manutenções feitas (placa = 1, cada peça usada de vez = 1) e aparelhos reparados;
--   aprovados / reprovados  resultado registrado na quarentena.
-- Também: o supervisor pode ser função somada a outra (o admin atribui mais de uma função).

alter table public.profiles drop constraint if exists profiles_extra_roles_check;
alter table public.profiles
  add constraint profiles_extra_roles_check
  check (extra_roles <@ array['tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro', 'supervisor']::public.user_role[]);

-- Aparelho por aparelho de cada balão.
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
      from public.repair_stages st
      join public.service_orders o on o.id = st.os_id, w
     where p_kind = 'reparos' and st.stage = 'manutencao' and st.status = 'concluida' and st.maintenance_count > 0
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

-- Os balões.
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
    'aprovados', (select count(distinct lower(btrim(d.serial))) from public.repair_dashboard_devices('aprovados', p_from, p_to) d),
    'reprovados', (select count(distinct lower(btrim(d.serial))) from public.repair_dashboard_devices('reprovados', p_from, p_to) d)
  )
  where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]));
$$;

-- Resultado individual de cada colaborador (só quem fez alguma coisa no período).
-- (A 71 acrescenta uma coluna; o drop deixa este arquivo rodar de novo depois dela.)
drop function if exists public.repair_dashboard_people(date, date);
create or replace function public.repair_dashboard_people(p_from date, p_to date)
returns table (user_id uuid, name text, manutencoes bigint, quarentena bigint, placas bigint, vidros bigint)
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
    select uid from m union select uid from qq union select uid from pl union select uid from vd
  )
  select ids.uid, coalesce(nullif(btrim(p.name), ''), p.email),
         coalesce(m.n, 0), coalesce(qq.n, 0), coalesce(pl.n, 0), coalesce(vd.n, 0)
  from ids
  join public.profiles p on p.id = ids.uid
  left join m on m.uid = ids.uid
  left join qq on qq.uid = ids.uid
  left join pl on pl.uid = ids.uid
  left join vd on vd.uid = ids.uid
  where ids.uid is not null
    and (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by 2;
$$;

-- Desempenho diário de um colaborador.
drop function if exists public.repair_dashboard_person_daily(uuid, date, date);
create or replace function public.repair_dashboard_person_daily(p_user uuid, p_from date, p_to date)
returns table (day date, manutencoes bigint, quarentena bigint, placas bigint, vidros bigint)
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
    select d from m union select d from qq union select d from pl union select d from vd
  )
  select days.d, coalesce(m.n, 0), coalesce(qq.n, 0), coalesce(pl.n, 0), coalesce(vd.n, 0)
  from days
  left join m on m.d = days.d
  left join qq on qq.d = days.d
  left join pl on pl.d = days.d
  left join vd on vd.d = days.d
  where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by 1 desc;
$$;

-- Peças no período (pelas movimentações do estoque).
create or replace function public.repair_dashboard_parts(p_from date, p_to date)
returns table (part text, definitivas bigint, testes bigint, testes_usados bigint, devolvidas bigint, defeito bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select (p_from::timestamp at time zone 'America/Sao_Paulo') as t0,
           ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo') as t1
  )
  select min(r.part),
         coalesce(sum(m.qty) filter (where m.kind = 'entrega' and r.purpose = 'definitiva'), 0)::bigint,
         coalesce(sum(m.qty) filter (where m.kind = 'entrega' and r.purpose = 'teste'), 0)::bigint,
         count(*) filter (where m.kind = 'destino_teste' and m.detail ->> 'destino' = 'utilizacao_definitiva')::bigint,
         coalesce(sum(m.qty) filter (where m.kind = 'recebimento' and ret.reason = 'devolucao_teste'), 0)::bigint,
         coalesce(sum(m.qty) filter (where m.kind = 'substituicao_solicitada'), 0)::bigint
  from public.stock_movements m
  join public.stock_requests r on r.id = m.request_id
  left join public.stock_returns ret on ret.id = m.return_id, w
  where m.created_at >= w.t0 and m.created_at < w.t1
    and m.kind in ('entrega', 'destino_teste', 'recebimento', 'substituicao_solicitada')
    and (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  group by r.part_key
  order by 1;
$$;

-- Aparelho por aparelho de uma peça.
create or replace function public.repair_dashboard_part_devices(p_part text, p_from date, p_to date)
returns table (serial text, os_number text, model text, person text, at timestamptz, detail text)
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select (p_from::timestamp at time zone 'America/Sao_Paulo') as t0,
           ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo') as t1
  )
  select r.serial, o.os_number, a.model, coalesce(nullif(btrim(p.name), ''), p.email), m.created_at,
         case
           when m.kind = 'entrega' and r.purpose = 'definitiva' then 'Definitiva entregue (' || m.qty || ')'
           when m.kind = 'entrega' then 'Teste entregue'
           when m.kind = 'destino_teste' then 'Teste usado de vez'
           when m.kind = 'recebimento' then 'Teste devolvido'
           else 'Defeito: substituição (' || m.qty || ')'
         end
  from public.stock_movements m
  join public.stock_requests r on r.id = m.request_id
  join public.service_orders o on o.id = r.os_id
  left join public.stock_returns ret on ret.id = m.return_id
  left join public.profiles p on p.id = r.requested_by
  left join public.assets a on a.serial_key = r.serial_key, w
  where r.part_key = lower(btrim(coalesce(p_part, '')))
    and m.created_at >= w.t0 and m.created_at < w.t1
    and (m.kind in ('entrega', 'substituicao_solicitada')
         or (m.kind = 'destino_teste' and m.detail ->> 'destino' = 'utilizacao_definitiva')
         or (m.kind = 'recebimento' and ret.reason = 'devolucao_teste'))
    and (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
  order by m.created_at desc
  limit 2000;
$$;

revoke all on function public.repair_dashboard_devices(text, date, date) from public, anon;
revoke all on function public.repair_dashboard_summary(date, date) from public, anon;
revoke all on function public.repair_dashboard_people(date, date) from public, anon;
revoke all on function public.repair_dashboard_person_daily(uuid, date, date) from public, anon;
revoke all on function public.repair_dashboard_parts(date, date) from public, anon;
revoke all on function public.repair_dashboard_part_devices(text, date, date) from public, anon;
grant execute on function public.repair_dashboard_devices(text, date, date) to authenticated;
grant execute on function public.repair_dashboard_summary(date, date) to authenticated;
grant execute on function public.repair_dashboard_people(date, date) to authenticated;
grant execute on function public.repair_dashboard_person_daily(uuid, date, date) to authenticated;
grant execute on function public.repair_dashboard_parts(date, date) to authenticated;
grant execute on function public.repair_dashboard_part_devices(text, date, date) to authenticated;
