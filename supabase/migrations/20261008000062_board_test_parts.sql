-- Reparo em placa: o analista também pega peça emprestada para teste (e decide usar ou devolver).
-- Rode depois de 20261008000061_analysis_test_parts.sql. Pode rodar de novo.
--
-- O pedido de peça de teste vale na análise em andamento (de quem a começou) e no reparo em placa em andamento (de quem
-- o iniciou). Pedir pausa o cronômetro da fase (espera de peça). O reparo em placa só finaliza com as peças de teste
-- resolvidas; a peça usada como definitiva vai junto com o aparelho.

create or replace function public.analysis_request_test_part(p_id uuid, p_part text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.repair_analysis_queue;
  v_part text := btrim(coalesce(p_part, ''));
  v_phase text;
  v_owner uuid;
  v_id uuid;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_part = '' or char_length(v_part) > 60 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if q.status = 'em_analise' then
    v_phase := 'analise';
    v_owner := q.started_by;
  elsif q.board_status = 'em_andamento' then
    v_phase := 'reparo_placa';
    v_owner := q.board_by;
  else
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if v_owner is distinct from (select auth.uid()) and not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  insert into public.stock_requests (os_id, stage_id, origin_stage, serial, part, purpose, qty, analysis_id)
  values (q.os_id, q.stage_id, 'analise', q.serial, v_part, 'teste', 1, p_id)
  returning id into v_id;
  perform public.stock_log(v_id, null, 'solicitacao', 1, 0,
    jsonb_build_object('part', v_part, 'purpose', 'teste', 'origem', case when v_phase = 'analise' then 'analise_tecnica' else 'reparo_placa' end), null);

  if exists (select 1 from public.repair_timer_sessions
              where analysis_id = p_id and ended_at is null and kind = 'produtivo' and phase is not distinct from v_phase) then
    perform public.repair_analysis_timer_switch(p_id, 'espera_peca', v_phase);
  end if;
  return v_id;
end;
$$;

revoke all on function public.analysis_request_test_part(uuid, text) from public, anon;
grant execute on function public.analysis_request_test_part(uuid, text) to authenticated;

-- Finalizar o reparo em placa (corpo da migration 60 + peças de teste resolvidas e levadas junto).
create or replace function public.finish_board_repair(p_id uuid, p_note text, p_destination text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.repair_analysis_queue;
  v_me uuid := (select auth.uid());
  v_note text := btrim(coalesce(p_note, ''));
  v_src public.repair_stages;
  v_stage public.repair_stages;
  v_round integer;
  v_tech uuid;
  v_out uuid;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_destination not in ('quarentena', 'vidro', 'estagio2') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found or q.board_status is distinct from 'em_andamento' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if q.board_by is distinct from v_me and not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if char_length(v_note) < 5 then
    raise exception 'note_required' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.repair_analysis_parts(p_id) r
              where r.status in ('pendente', 'em_separacao', 'sem_estoque') or (r.status = 'entregue' and r.test_destiny is null)) then
    raise exception 'analysis_parts_pending' using errcode = 'P0001';
  end if;

  select * into v_src from public.repair_stages where id = q.stage_id;
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = q.os_id and stage = 'desmontagem';
  v_tech := coalesce(
    q.sent_by,
    v_src.technician_id,
    (select technician_id from public.repair_stages where os_id = q.os_id and stage = 'desmontagem' and round = v_round)
  );

  perform public.repair_analysis_timer_switch(p_id, null);
  update public.repair_analysis_queue
     set board_status = 'concluido', board_finished_at = now(), board_note = v_note, board_destination = p_destination
   where id = p_id;

  if p_destination = 'vidro' then
    perform public.repair_open_glass(v_src, 'analise', v_tech);
  elsif p_destination = 'estagio2' then
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
    -- A peça de teste usada como definitiva vai junto com o aparelho para o Estágio 2.
    update public.stock_requests set stage_id = v_stage.id
     where id in (select r.id from public.repair_analysis_parts(p_id) r);
    v_out := v_stage.id;
  end if;

  perform public.repair_log(q.os_id, q.stage_id, null, 'reparo_placa_concluido',
    jsonb_build_object('destino', p_destination, 'observacao', v_note, 'devolvido_a', v_tech));
  return v_out;
end;
$$;

revoke all on function public.finish_board_repair(uuid, text, text) from public, anon;
grant execute on function public.finish_board_repair(uuid, text, text) to authenticated;
