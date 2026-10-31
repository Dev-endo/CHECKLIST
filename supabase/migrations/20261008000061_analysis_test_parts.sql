-- Análise técnica: o analista pede peça para teste; testada, devolve ao estoque ou usa como definitiva.
-- Rode depois de 20261008000060_return_to_sender.sql. Pode rodar de novo.
--
-- Regras:
--   * Só durante a análise em andamento, por quem a começou (ou o admin). Uma unidade por tipo (regra do teste).
--   * Pedir peça pausa o cronômetro da análise (espera de peça); o analista retoma quando quiser.
--   * Peça entregue: "Solicitar devolução" (o estoquista confirma o recebimento) ou "Utilização definitiva".
--   * Para finalizar a análise, toda peça de teste dela precisa estar resolvida (sem pedido aberto e com destino).
--   * Com peça marcada como definitiva, "Troca de periférico" pode ser finalizada sem pedir outra peça: o aparelho
--     volta, com a peça, ao Estágio 2 de quem mandou para a análise.

alter table public.stock_requests drop constraint if exists stock_requests_origin_stage_check;
alter table public.stock_requests
  add constraint stock_requests_origin_stage_check check (origin_stage in ('desmontagem', 'avaliacao', 'manutencao', 'analise'));

alter table public.stock_requests
  add column if not exists analysis_id uuid references public.repair_analysis_queue (id) on delete set null;
create index if not exists stock_requests_analysis_idx on public.stock_requests (analysis_id) where analysis_id is not null;

-- Peças de teste do ciclo atual da análise (a linha da fila é reaproveitada quando o aparelho volta a ela).
create or replace function public.repair_analysis_parts(p_id uuid) returns setof public.stock_requests
language sql
stable
security definer
set search_path = ''
as $$
  select r.* from public.stock_requests r
  join public.repair_analysis_queue q on q.id = r.analysis_id
  where r.analysis_id = p_id and q.started_at is not null and r.created_at >= q.started_at;
$$;

revoke all on function public.repair_analysis_parts(uuid) from public, anon, authenticated;

-- O analista pede uma peça para teste.
create or replace function public.analysis_request_test_part(p_id uuid, p_part text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.repair_analysis_queue;
  v_part text := btrim(coalesce(p_part, ''));
  v_id uuid;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_part = '' or char_length(v_part) > 60 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found or q.status <> 'em_analise' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if q.started_by is distinct from (select auth.uid()) and not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  insert into public.stock_requests (os_id, stage_id, origin_stage, serial, part, purpose, qty, analysis_id)
  values (q.os_id, q.stage_id, 'analise', q.serial, v_part, 'teste', 1, p_id)
  returning id into v_id;
  perform public.stock_log(v_id, null, 'solicitacao', 1, 0,
    jsonb_build_object('part', v_part, 'purpose', 'teste', 'origem', 'analise_tecnica'), null);

  -- O tempo produtivo da análise vira espera de peça (pausa manual continua pausa).
  if exists (select 1 from public.repair_timer_sessions
              where analysis_id = p_id and ended_at is null and kind = 'produtivo') then
    perform public.repair_analysis_timer_switch(p_id, 'espera_peca', 'analise');
  end if;
  return v_id;
end;
$$;

revoke all on function public.analysis_request_test_part(uuid, text) from public, anon;
grant execute on function public.analysis_request_test_part(uuid, text) to authenticated;

-- O analista também define o destino da peça de teste entregue (mesmo corpo da migration 46, com o analista).
create or replace function public.define_test_destiny(p_id uuid, p_destiny text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.stock_requests;
  v_ret uuid;
  v_me uuid := (select auth.uid());
begin
  if not (select public.has_any_role(array['admin', 'tecnico', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_destiny not in ('utilizacao_definitiva', 'devolucao') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into r from public.stock_requests where id = p_id for update;
  if not found or r.purpose <> 'teste' or r.status <> 'entregue' then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  if r.test_destiny is not null then
    raise exception 'destino já definido' using errcode = 'P0001';
  end if;

  update public.stock_requests set test_destiny = p_destiny, test_destiny_at = now(), test_destiny_by = v_me where id = p_id;
  perform public.stock_log(p_id, null, 'destino_teste', 0, 0, jsonb_build_object('destino', p_destiny), null);

  if p_destiny = 'devolucao' then
    insert into public.stock_returns (request_id, os_id, serial, part, reason, qty)
    values (r.id, r.os_id, r.serial, r.part, 'devolucao_teste', 1)
    returning id into v_ret;
    perform public.stock_log(p_id, v_ret, 'devolucao_solicitada', 1, 0, '{}', null);
  end if;
  return v_ret;
end;
$$;

revoke all on function public.define_test_destiny(uuid, text) from public, anon;
grant execute on function public.define_test_destiny(uuid, text) to authenticated;

-- Totais do cronômetro da análise agora contam a espera de peça.
create or replace function public.analysis_timer_totals(p_id uuid, p_phase text default 'analise') returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'produtivo', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'produtivo'), 0)::bigint,
    'pausa', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'pausa'), 0)::bigint,
    'espera_peca', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'espera_peca'), 0)::bigint,
    'open_kind', (select o.kind from public.repair_timer_sessions o
                   where o.analysis_id = p_id and o.ended_at is null and o.phase is not distinct from p_phase),
    'server_now', now()
  )
  from (select 1) base
  left join public.repair_timer_sessions s on s.analysis_id = p_id and s.phase is not distinct from p_phase
  where (select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]));
$$;

revoke all on function public.analysis_timer_totals(uuid, text) from public, anon;
grant execute on function public.analysis_timer_totals(uuid, text) to authenticated;

-- Finalizar a análise (corpo da migration 60 + peças de teste da análise).
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
  v_kept boolean;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_result not in ('troca_periferico', 'reparo_placa') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;

  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found or q.status <> 'em_analise' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if q.started_by is distinct from v_me and not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  -- Peça de teste da análise ainda aberta ou entregue sem destino: resolver antes de finalizar.
  if exists (select 1 from public.repair_analysis_parts(p_id) r
              where r.status in ('pendente', 'em_separacao', 'sem_estoque') or (r.status = 'entregue' and r.test_destiny is null)) then
    raise exception 'analysis_parts_pending' using errcode = 'P0001';
  end if;
  v_kept := exists (select 1 from public.repair_analysis_parts(p_id) r where r.test_destiny = 'utilizacao_definitiva');

  if p_result = 'troca_periferico' and not v_kept
     and (jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0) then
    raise exception 'parts_required' using errcode = 'P0001';
  end if;

  perform public.repair_analysis_timer_switch(p_id, null);

  if p_result = 'reparo_placa' then
    update public.repair_analysis_queue
       set status = 'concluida', result = p_result, finished_by = v_me, finished_at = now(), board_status = 'aguardando'
     where id = p_id;
    perform public.repair_log(q.os_id, q.stage_id, null, 'analise_concluida', jsonb_build_object('resultado', p_result));
    return null;
  end if;

  select * into v_src from public.repair_stages where id = q.stage_id;
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = q.os_id and stage = 'desmontagem';
  v_tech := coalesce(
    q.sent_by,
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
       set status = 'em_andamento', finished_at = null, outcome = null, resale_reason = null, failed_tests = '[]'::jsonb,
           technician_id = v_tech
     where id = v_stage.id
    returning * into v_stage;
  end if;

  -- As peças de teste da análise acompanham o aparelho no Estágio 2 (a definitiva vai junto, sem nova baixa).
  update public.stock_requests set stage_id = v_stage.id
   where id in (select r.id from public.repair_analysis_parts(p_id) r);

  if jsonb_typeof(p_parts) = 'array' then
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

  update public.repair_analysis_queue
     set status = 'concluida', result = p_result, finished_by = v_me, finished_at = now()
   where id = p_id;
  perform public.repair_log(q.os_id, v_stage.id, null, 'analise_concluida',
    jsonb_build_object('resultado', p_result, 'pecas', p_parts, 'devolvido_a', v_tech, 'teste_definitivo', v_kept));
  return v_stage.id;
end;
$$;

revoke all on function public.finish_analysis(uuid, text, jsonb) from public, anon;
grant execute on function public.finish_analysis(uuid, text, jsonb) to authenticated;

-- O analista cancela a peça que ele pediu (mesmo corpo da migration 56, com o analista).
create or replace function public.cancel_stock_request(p_id uuid, p_reason text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.stock_requests;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_me uuid := (select auth.uid());
begin
  if not (select public.has_any_role(array['admin', 'tecnico', 'estoquista', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into r from public.stock_requests where id = p_id for update;
  if not found then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  -- Quem pediu, o técnico da OS, o estoquista e o admin cancelam.
  if r.requested_by <> v_me
     and not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[]))
     and not exists (select 1 from public.repair_stages s where s.os_id = r.os_id and s.technician_id = v_me) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if r.status not in ('pendente', 'em_separacao', 'sem_estoque') or r.qty_delivered > 0 then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  update public.stock_requests
     set status = 'cancelada', cancel_reason = v_reason, cancelled_by = v_me, cancelled_at = now()
   where id = p_id;
  perform public.stock_log(p_id, null, 'cancelamento', 0, 0, jsonb_build_object('motivo', v_reason), null);
end;
$$;

revoke all on function public.cancel_stock_request(uuid, text) from public, anon;
grant execute on function public.cancel_stock_request(uuid, text) to authenticated;
