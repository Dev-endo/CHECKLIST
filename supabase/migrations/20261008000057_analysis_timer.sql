-- Análise técnica: cronômetro (iniciar, pausar, retomar), persistido no banco como os dos estágios.
-- Rode depois de 20261008000056_technical_analysis.sql. Pode rodar de novo.
--
-- Começar a análise já liga o cronômetro; finalizar a encerra. Uma única sessão aberta por análise.
-- Análises já em andamento ganham uma sessão aberta desde a hora em que começaram.

alter table public.repair_timer_sessions alter column stage_id drop not null;
alter table public.repair_timer_sessions
  add column if not exists analysis_id uuid references public.repair_analysis_queue (id) on delete cascade;

alter table public.repair_timer_sessions drop constraint if exists repair_timer_owner_chk;
alter table public.repair_timer_sessions
  add constraint repair_timer_owner_chk check ((stage_id is null) <> (analysis_id is null));

create unique index if not exists repair_timer_analysis_open_idx
  on public.repair_timer_sessions (analysis_id) where ended_at is null and analysis_id is not null;
create index if not exists repair_timer_analysis_idx on public.repair_timer_sessions (analysis_id, started_at);

-- Troca o tipo da sessão aberta da análise (null só encerra). Fecha e abre no mesmo instante.
create or replace function public.repair_analysis_timer_switch(p_analysis uuid, p_kind text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_open public.repair_timer_sessions;
begin
  select * into v_open from public.repair_timer_sessions where analysis_id = p_analysis and ended_at is null for update;
  if found then
    if v_open.kind = p_kind then
      return;
    end if;
    update public.repair_timer_sessions set ended_at = v_now where id = v_open.id;
  end if;
  if p_kind is not null then
    insert into public.repair_timer_sessions (analysis_id, kind, started_at) values (p_analysis, p_kind, v_now);
  end if;
end;
$$;

revoke all on function public.repair_analysis_timer_switch(uuid, text) from public, anon, authenticated;

-- Iniciar / pausar / retomar: só quem começou a análise (ou o admin), enquanto ela está em andamento.
create or replace function public.analysis_timer_set(p_id uuid, p_kind text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.repair_analysis_queue;
begin
  if p_kind not in ('produtivo', 'pausa') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found
     or not (select public.has_any_role(array['admin', 'analista']::public.user_role[]))
     or (q.started_by is distinct from (select auth.uid()) and not (select public.has_any_role(array['admin']::public.user_role[]))) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if q.status <> 'em_analise' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  perform public.repair_analysis_timer_switch(p_id, p_kind);
  perform public.repair_log(q.os_id, q.stage_id, null, 'cronometro_analise_' || p_kind);
end;
$$;

create or replace function public.analysis_timer_totals(p_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'produtivo', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'produtivo'), 0)::bigint,
    'pausa', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'pausa'), 0)::bigint,
    'espera_peca', 0,
    'open_kind', (select o.kind from public.repair_timer_sessions o where o.analysis_id = p_id and o.ended_at is null),
    'server_now', now()
  )
  from (select 1) base
  left join public.repair_timer_sessions s on s.analysis_id = p_id
  where (select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]));
$$;

revoke all on function public.analysis_timer_set(uuid, text) from public, anon;
revoke all on function public.analysis_timer_totals(uuid) from public, anon;
grant execute on function public.analysis_timer_set(uuid, text) to authenticated;
grant execute on function public.analysis_timer_totals(uuid) to authenticated;

-- Começar a análise liga o cronômetro.
create or replace function public.start_analysis(p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.repair_analysis_queue;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found or q.status <> 'aguardando' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  update public.repair_analysis_queue
     set status = 'em_analise', started_by = (select auth.uid()), started_at = now()
   where id = p_id;
  perform public.repair_analysis_timer_switch(p_id, 'produtivo');
  perform public.repair_log(q.os_id, q.stage_id, null, 'analise_iniciada');
end;
$$;

-- Voltou à fila depois de concluída: o ciclo novo começa sem sessões abertas (as antigas ficam no histórico).
-- (A reabertura da fila já zera started_*/finished_*; as sessões encerradas continuam guardadas.)

-- Finalizar a análise encerra o cronômetro (mesmo corpo da migration 56, com o encerramento acrescentado).
create or replace function public.finish_analysis(p_id uuid, p_result text, p_parts jsonb default '[]') returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.repair_analysis_queue;
  v_me uuid := (select auth.uid());
  v_src public.repair_stages;
  v_stage public.repair_stages;
  v_round integer;
  v_tech uuid;
  v_item jsonb;
  v_part text;
  v_purpose text;
  v_qty integer;
  v_req uuid;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_result not in ('troca_periferico', 'reparo_placa') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  if p_result = 'troca_periferico' and (jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0) then
    raise exception 'parts_required' using errcode = 'P0001';
  end if;

  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found or q.status <> 'em_analise' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if q.started_by is distinct from v_me and not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  select * into v_src from public.repair_stages where id = q.stage_id;
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = q.os_id and stage = 'desmontagem';
  v_tech := coalesce(
    v_src.technician_id,
    (select technician_id from public.repair_stages where os_id = q.os_id and stage = 'desmontagem' and round = v_round)
  );

  select * into v_stage from public.repair_stages where os_id = q.os_id and stage = 'manutencao' and round = v_round;
  if not found then
    insert into public.repair_stages (os_id, serial, stage, technician_id, round)
    values (q.os_id, q.serial, 'manutencao', v_tech, v_round)
    returning * into v_stage;
  elsif v_stage.status = 'concluida' then
    update public.repair_stages
       set status = 'em_andamento', finished_at = null, outcome = null, resale_reason = null, failed_tests = '[]'::jsonb
     where id = v_stage.id
    returning * into v_stage;
  end if;

  if p_result = 'troca_periferico' then
    for v_item in select * from jsonb_array_elements(p_parts) loop
      v_part := btrim(coalesce(v_item ->> 'part', ''));
      v_purpose := v_item ->> 'purpose';
      v_qty := case when v_purpose = 'teste' then 1 else coalesce((v_item ->> 'qty')::integer, 1) end;
      if v_part = '' or char_length(v_part) > 60 or v_purpose not in ('teste', 'definitiva') or v_qty not between 1 and 99 then
        raise exception 'dados incompletos' using errcode = '22023';
      end if;
      insert into public.stock_requests (os_id, stage_id, origin_stage, serial, part, purpose, qty)
      values (q.os_id, v_stage.id, 'manutencao', q.serial, v_part, v_purpose, v_qty)
      returning id into v_req;
      perform public.stock_log(v_req, null, 'solicitacao', v_qty, 0,
        jsonb_build_object('part', v_part, 'purpose', v_purpose, 'origem', 'analise_tecnica'), null);
    end loop;
  end if;

  perform public.repair_analysis_timer_switch(p_id, null);
  update public.repair_analysis_queue
     set status = 'concluida', result = p_result, finished_by = v_me, finished_at = now()
   where id = p_id;
  perform public.repair_log(q.os_id, v_stage.id, null, 'analise_concluida',
    jsonb_build_object('resultado', p_result, 'pecas', case when p_result = 'troca_periferico' then p_parts else '[]'::jsonb end));
  return v_stage.id;
end;
$$;

revoke all on function public.start_analysis(uuid) from public, anon;
revoke all on function public.finish_analysis(uuid, text, jsonb) from public, anon;
grant execute on function public.start_analysis(uuid) to authenticated;
grant execute on function public.finish_analysis(uuid, text, jsonb) to authenticated;

-- Análises que já estavam em andamento: o tempo conta desde que foram começadas.
insert into public.repair_timer_sessions (analysis_id, kind, started_at, user_id)
select q.id, 'produtivo', q.started_at, q.started_by
from public.repair_analysis_queue q
where q.status = 'em_analise'
  and q.started_at is not null
  and not exists (select 1 from public.repair_timer_sessions t where t.analysis_id = q.id);
