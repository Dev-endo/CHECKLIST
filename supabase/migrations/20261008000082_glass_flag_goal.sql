-- Vidro identificado no Estágio 1 / Checklist manutenção, peças de teste na Análise e meta diária do técnico.
-- Rode depois de 20261008000081_test_part_kept_notice.sql. Pode rodar de novo.
--
-- 1) "O aparelho é vidro?"
--    * Só vidro: como antes, o Estágio 1 manda direto para o Vidro (pede Vidro e Aro).
--    * Vidro e outra manutenção: o aparelho vai para o Estágio 2 e o Vidro e o Aro já são pedidos ao estoque. A etapa
--      fica marcada (needs_glass); ao finalizar com destino Vidro, não pede as peças de novo. No Checklist manutenção,
--      o técnico marca o mesmo pela função request_glass_parts.
--    * As peças do vidro (stock_requests.glass) são do técnico de vidro: não travam a finalização da manutenção, não
--      seguram "Aguardando peças"/"Espera de peça" e não contam como manutenção de quem finaliza.
-- 2) Aba Análise > Colaborador: coluna "Peças de teste usadas de vez" (já contam nas manutenções) e a justificativa
--    da meta no desempenho diário.
-- 3) Meta diária: aparelhos liberados para a quarentena e para o vidro (meta 6). Abaixo da meta, o técnico justifica.

-- 1) Vidro ----------------------------------------------------------------------------------------------------------

alter table public.stock_requests add column if not exists glass boolean not null default false;
alter table public.repair_stages add column if not exists needs_glass boolean not null default false;

-- Pedidos de vidro já feitos (o pedido registrou "vidro": true na movimentação).
update public.stock_requests r
   set glass = true
 where not r.glass
   and exists (select 1 from public.stock_movements m
                where m.request_id = r.id and m.kind = 'solicitacao' and (m.detail ->> 'vidro') = 'true');

-- Pede Vidro e Aro para a etapa (peças do técnico de vidro).
create or replace function public.repair_request_glass_parts(p_stage public.repair_stages, p_origin text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_part text;
  v_req uuid;
begin
  foreach v_part in array array['Vidro', 'Aro'] loop
    insert into public.stock_requests (os_id, stage_id, origin_stage, serial, part, purpose, qty, glass)
    values (p_stage.os_id, p_stage.id, p_origin, p_stage.serial, v_part, 'definitiva', 1, true)
    returning id into v_req;
    perform public.stock_log(v_req, null, 'solicitacao', 1, 0, jsonb_build_object('part', v_part, 'purpose', 'definitiva', 'vidro', true), null);
  end loop;
end;
$$;

revoke all on function public.repair_request_glass_parts(public.repair_stages, text) from public, anon, authenticated;

-- Abre o serviço de vidro. Se a etapa já pediu as peças (vidro e outra manutenção), não pede de novo.
create or replace function public.repair_open_glass(p_stage public.repair_stages, p_origin text, p_responsible uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job uuid;
  v_asked boolean;
begin
  insert into public.repair_glass_jobs (os_id, stage_id, serial, origin, responsible_id)
  values (p_stage.os_id, p_stage.id, p_stage.serial, p_origin, p_responsible)
  returning id into v_job;

  select needs_glass into v_asked from public.repair_stages where id = p_stage.id;
  if coalesce(v_asked, false) then
    update public.repair_stages set needs_glass = false where id = p_stage.id;
  else
    perform public.repair_request_glass_parts(p_stage, case when p_origin = 'avaliacao' then 'avaliacao' else 'manutencao' end);
  end if;

  perform public.repair_log(p_stage.os_id, p_stage.id, null, 'vidro_solicitado',
    jsonb_build_object('origem', p_origin, 'pecas_ja_pedidas', coalesce(v_asked, false)));
  return v_job;
end;
$$;

revoke all on function public.repair_open_glass(public.repair_stages, text, uuid) from public, anon, authenticated;

-- Manutenção em andamento (Estágio 2 ou Checklist manutenção): "vidro e outra manutenção" pede Vidro e Aro agora.
create or replace function public.request_glass_parts(p_stage_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
begin
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'manutencao' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  if v_stage.needs_glass then
    return;
  end if;
  perform public.repair_request_glass_parts(v_stage, 'manutencao');
  update public.repair_stages set needs_glass = true where id = p_stage_id;
  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'vidro_identificado', jsonb_build_object('origem', 'manutencao'));
end;
$$;

revoke all on function public.request_glass_parts(uuid) from public, anon;
grant execute on function public.request_glass_parts(uuid) to authenticated;

-- Fim do Estágio 1 (corpo da migration 77 + p_glass: vidro e outra manutenção).
drop function if exists public.finish_evaluation(uuid, text, text);

create or replace function public.finish_evaluation(
  p_stage_id uuid, p_destination text default 'manutencao', p_note text default null, p_glass boolean default false
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
  v_next uuid;
  v_next_stage public.repair_stages;
  v_note text := btrim(coalesce(p_note, ''));
  v_glass boolean := coalesce(p_glass, false) and p_destination in ('manutencao', 'aguardando_pecas');
begin
  if p_destination not in ('manutencao', 'vidro', 'analise', 'aguardando_pecas') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'avaliacao' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  -- Indo para a Análise técnica: o técnico explica o motivo.
  if p_destination = 'analise' and char_length(v_note) < 5 then
    raise exception 'analysis_note_required' using errcode = 'P0001';
  end if;
  if p_destination = 'aguardando_pecas'
     and not exists (select 1 from public.stock_requests
                      where os_id = v_stage.os_id and status in ('pendente', 'em_separacao', 'sem_estoque') and not glass) then
    raise exception 'nothing_to_wait' using errcode = 'P0001';
  end if;

  perform public.repair_timer_switch(p_stage_id, null);
  update public.repair_stages
     set status = 'concluida', finished_at = now(), destination = p_destination
   where id = p_stage_id;

  if p_destination in ('manutencao', 'aguardando_pecas') then
    insert into public.repair_stages (os_id, serial, stage, technician_id, status, round)
    values (v_stage.os_id, v_stage.serial, 'manutencao', v_stage.technician_id,
            case when p_destination = 'aguardando_pecas' then 'aguardando_pecas' else 'em_andamento' end, v_stage.round)
    on conflict (os_id, stage, round) do nothing
    returning id into v_next;
    if v_next is null then
      select id into v_next from public.repair_stages where os_id = v_stage.os_id and stage = 'manutencao' and round = v_stage.round;
    end if;
    update public.stock_requests set stage_id = v_next
     where os_id = v_stage.os_id and status in ('pendente', 'em_separacao', 'sem_estoque') and stage_id = p_stage_id;

    -- Vidro e outra manutenção: Vidro e Aro já pedidos; ao finalizar o Estágio 2, o aparelho vai para o vidro.
    if v_glass then
      select * into v_next_stage from public.repair_stages where id = v_next for update;
      if not v_next_stage.needs_glass then
        perform public.repair_request_glass_parts(v_next_stage, 'avaliacao');
        update public.repair_stages set needs_glass = true where id = v_next;
      end if;
    end if;

  elsif p_destination = 'vidro' then
    perform public.repair_open_glass(v_stage, 'avaliacao', v_stage.technician_id);

  else
    insert into public.repair_analysis_queue (os_id, stage_id, serial, source, send_note)
    values (v_stage.os_id, p_stage_id, v_stage.serial, 'estagio1', left(v_note, 1000))
    on conflict (os_id) do update
      set status = 'aguardando', stage_id = excluded.stage_id, source = 'estagio1', send_note = excluded.send_note;
  end if;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'avaliacao_concluida',
    jsonb_build_object('destino', p_destination, 'proxima_etapa', v_next, 'vidro_e_manutencao', v_glass,
      'motivo_analise', case when p_destination = 'analise' then nullif(v_note, '') end));
  return v_next;
end;
$$;

revoke all on function public.finish_evaluation(uuid, text, text, boolean) from public, anon;
grant execute on function public.finish_evaluation(uuid, text, text, boolean) to authenticated;

-- O que impede finalizar a manutenção: pedido de vidro em aberto não trava (é do técnico de vidro).
create or replace function public.repair_finish_blockers(p_os_id uuid) returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[
    case when exists (select 1 from public.stock_requests
                       where os_id = p_os_id and status in ('pendente', 'em_separacao', 'sem_estoque') and not glass)
         then 'request_pending' end,
    case when exists (select 1 from public.stock_requests
                       where os_id = p_os_id and purpose = 'teste' and status = 'entregue' and test_destiny is null)
         then 'test_destiny_missing' end,
    case when exists (select 1 from public.stock_returns
                       where os_id = p_os_id and status = 'aguardando_recebimento')
         then 'return_unconfirmed' end
  ], null);
$$;

revoke all on function public.repair_finish_blockers(uuid) from public, anon;
grant execute on function public.repair_finish_blockers(uuid) to authenticated;

-- Aguardando peças (migration 52): o pedido de vidro não segura o Estágio 2.
create or replace function public.repair_release_waiting() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if new.status in ('entregue', 'cancelada') and old.status is distinct from new.status
     and not exists (select 1 from public.stock_requests
                      where os_id = new.os_id and status in ('pendente', 'em_separacao', 'sem_estoque') and not glass) then
    update public.repair_stages set status = 'em_andamento'
     where os_id = new.os_id and stage = 'manutencao' and status = 'aguardando_pecas'
    returning id into v_id;
    if v_id is not null then
      perform public.repair_log(new.os_id, v_id, null, 'pecas_recebidas', '{}');
    end if;
  end if;
  return null;
end;
$$;

-- Espera de peça (migration 80): o pedido de vidro não segura a espera.
create or replace function public.repair_end_part_wait() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.repair_timer_sessions;
begin
  if new.status in ('entregue', 'cancelada') and old.status is distinct from new.status
     and not exists (select 1 from public.stock_requests
                      where os_id = new.os_id and status in ('pendente', 'em_separacao', 'sem_estoque') and not glass) then
    for s in
      select ts.* from public.repair_timer_sessions ts
        join public.repair_stages st on st.id = ts.stage_id
       where st.os_id = new.os_id and ts.ended_at is null and ts.kind = 'espera_peca'
    loop
      perform public.repair_timer_switch(s.stage_id, 'pausa', s.phase);
      perform public.repair_log(new.os_id, s.stage_id, new.id, 'espera_peca_encerrada', '{}');
    end loop;
    for s in
      select ts.* from public.repair_timer_sessions ts
        join public.repair_analysis_queue q on q.id = ts.analysis_id
       where q.os_id = new.os_id and ts.ended_at is null and ts.kind = 'espera_peca'
    loop
      perform public.repair_analysis_timer_switch(s.analysis_id, 'pausa', s.phase);
      perform public.repair_log(new.os_id, null, new.id, 'espera_peca_encerrada', jsonb_build_object('analise', s.analysis_id));
    end loop;
  end if;
  return null;
end;
$$;

revoke all on function public.repair_end_part_wait() from public, anon, authenticated;

-- Manutenções de quem finaliza (corpo da migration 68): as peças do vidro não contam (são do técnico de vidro).
create or replace function public.repair_maintenance_items(p_stage_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with st as (
    select * from public.repair_stages where id = p_stage_id
  ),
  same_round as (
    select r.id from public.repair_stages r, st where r.os_id = st.os_id and r.round = st.round
  ),
  board as (
    select 1 as ord, 'Placa' as nome,
           jsonb_build_object('tipo', 'placa', 'descricao', q.board_note) as item
    from public.repair_analysis_queue q, st
    where q.os_id = st.os_id
      and q.board_status = 'concluido'
      and q.board_by = st.technician_id
      and q.stage_id in (select id from same_round)
  ),
  parts as (
    select 2 as ord, r.part as nome,
           jsonb_build_object('tipo', 'peca', 'peca', r.part,
             'qtd', case when r.purpose = 'teste' then 1
                         else r.qty_delivered - coalesce((select sum(t.qty) from public.stock_returns t
                                                           where t.request_id = r.id and t.reason = 'substituicao_defeito'), 0) end,
             'finalidade', r.purpose) as item
    from public.stock_requests r
    where r.stage_id in (select id from same_round)
      and not r.glass
      and (
        (r.purpose = 'definitiva'
          and r.qty_delivered - coalesce((select sum(t.qty) from public.stock_returns t
                                          where t.request_id = r.id and t.reason = 'substituicao_defeito'), 0) > 0)
        or (r.purpose = 'teste' and r.test_destiny = 'utilizacao_definitiva')
      )
  )
  select coalesce(jsonb_agg(x.item order by x.ord, x.nome), '[]'::jsonb)
  from (select * from board union all select * from parts) x
  where (select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]));
$$;

revoke all on function public.repair_maintenance_items(uuid) from public, anon;
grant execute on function public.repair_maintenance_items(uuid) to authenticated;

-- 3) Meta diária --------------------------------------------------------------------------------------------------

create table if not exists public.repair_goal_notes (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  note text not null check (char_length(note) between 5 and 1000),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.repair_goal_notes enable row level security;
revoke all on public.repair_goal_notes from anon, authenticated;
grant select on public.repair_goal_notes to authenticated;

drop policy if exists "repair_goal_notes_select" on public.repair_goal_notes;
create policy "repair_goal_notes_select" on public.repair_goal_notes
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])));

-- Liberados no dia (Brasília) por uma pessoa: aparelhos (serial) que ela mandou para a quarentena e para o vidro.
create or replace function public.repair_goal_count(p_user uuid, p_day date) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select (p_day::timestamp at time zone 'America/Sao_Paulo') as t0,
           ((p_day + 1)::timestamp at time zone 'America/Sao_Paulo') as t1
  ),
  q as (
    select count(distinct s.serial_key)::int as n from public.repair_quarantine_sends() s, w
     where s.sender_id = p_user and s.sent_at >= w.t0 and s.sent_at < w.t1
  ),
  g as (
    select count(distinct g.serial_key)::int as n from public.repair_glass_jobs g, w
     where g.requested_by = p_user and g.created_at >= w.t0 and g.created_at < w.t1
  )
  select jsonb_build_object('quarentena', q.n, 'vidro', g.n, 'liberados', q.n + g.n) from q, g;
$$;

revoke all on function public.repair_goal_count(uuid, date) from public, anon, authenticated;

-- A meta de hoje de quem está logado: liberados, meta (6) e a justificativa, se já escreveu.
create or replace function public.repair_my_goal() returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.repair_goal_count((select auth.uid()), (now() at time zone 'America/Sao_Paulo')::date)
         || jsonb_build_object(
              'meta', 6,
              'justificativa', (select n.note from public.repair_goal_notes n
                                 where n.user_id = (select auth.uid()) and n.day = (now() at time zone 'America/Sao_Paulo')::date));
$$;

revoke all on function public.repair_my_goal() from public, anon;
grant execute on function public.repair_my_goal() to authenticated;

-- Justificativa de hoje (abaixo da meta). Pode ser reescrita durante o dia.
create or replace function public.set_goal_note(p_note text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note text := btrim(coalesce(p_note, ''));
begin
  if (select auth.uid()) is null then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if char_length(v_note) < 5 then
    raise exception 'goal_note_required' using errcode = 'P0001';
  end if;
  insert into public.repair_goal_notes (user_id, day, note)
  values ((select auth.uid()), (now() at time zone 'America/Sao_Paulo')::date, left(v_note, 1000))
  on conflict (user_id, day) do update set note = excluded.note, updated_at = now();
end;
$$;

revoke all on function public.set_goal_note(text) from public, anon;
grant execute on function public.set_goal_note(text) to authenticated;

-- 2) Análise > Colaborador (corpo da migration 72 + peças de teste usadas de vez + justificativa da meta) ----------

drop function if exists public.repair_dashboard_people(date, date);

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

drop function if exists public.repair_dashboard_person_daily(uuid, date, date);

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

revoke all on function public.repair_dashboard_people(date, date) from public, anon;
revoke all on function public.repair_dashboard_person_daily(uuid, date, date) from public, anon;
grant execute on function public.repair_dashboard_people(date, date) to authenticated;
grant execute on function public.repair_dashboard_person_daily(uuid, date, date) to authenticated;
