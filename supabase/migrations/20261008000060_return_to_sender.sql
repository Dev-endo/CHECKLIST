-- Análise técnica: o aparelho volta para QUEM MANDOU para a análise (e não para o técnico da etapa).
-- Rode depois de 20261008000059_analysis_sent_by.sql. Pode rodar de novo.
--
-- Vale para o Estágio 2 aberto ou reaberto pela troca de periférico, pelo reparo em placa com destino Estágio 2 e
-- para o responsável do serviço de vidro pedido pelo reparo em placa. Sem remetente registrado (dado antigo), cai no
-- técnico da etapa, como antes.

-- Finalizar a análise (mesmo corpo da migration 58; a mudança é quem recebe o aparelho).
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
  -- Volta para quem mandou; sem remetente, para o técnico da etapa.
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

  update public.repair_analysis_queue
     set status = 'concluida', result = p_result, finished_by = v_me, finished_at = now()
   where id = p_id;
  perform public.repair_log(q.os_id, v_stage.id, null, 'analise_concluida',
    jsonb_build_object('resultado', p_result, 'pecas', p_parts, 'devolvido_a', v_tech));
  return v_stage.id;
end;
$$;

-- Finalizar o reparo em placa (mesmo corpo da migration 58; a mudança é quem recebe o aparelho).
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
    v_out := v_stage.id;
  end if;

  perform public.repair_log(q.os_id, q.stage_id, null, 'reparo_placa_concluido',
    jsonb_build_object('destino', p_destination, 'observacao', v_note, 'devolvido_a', v_tech));
  return v_out;
end;
$$;

revoke all on function public.finish_analysis(uuid, text, jsonb) from public, anon;
revoke all on function public.finish_board_repair(uuid, text, text) from public, anon;
grant execute on function public.finish_analysis(uuid, text, jsonb) to authenticated;
grant execute on function public.finish_board_repair(uuid, text, text) to authenticated;
