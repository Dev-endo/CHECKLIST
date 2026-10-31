-- Reparo em placa -> Quarentena: antes, o analista faz os checklists do Estágio 2 e a montagem (com cronômetro).
-- Rode depois de 20261008000065_stage2_assembly_timer.sql. Pode rodar de novo.
--
-- Escolher "Quarentena" ao finalizar o reparo em placa abre a manutenção (Estágio 2) em nome do próprio analista. Ele a
-- faz na aba Análise técnica > Checklist e montagem (checklists aberto/fechado, cronômetro de montagem) e finaliza:
-- tudo aprovado, o aparelho vai direto para a quarentena (reprovado volta à fila de Análise, como no Estágio 2).
-- Para isso, o analista passa a poder atuar na etapa que está em nome dele (como o técnico), inclusive pedir peça.

-- O reparo em placa com destino Quarentena passou pela manutenção do analista (checklists e montagem).
alter table public.repair_analysis_queue add column if not exists board_checklist boolean not null default false;

-- Quem pode agir na etapa: o técnico ou o analista dono dela, ou o admin.
create or replace function public.repair_can_act(p_stage public.repair_stages) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select public.has_any_role(array['admin']::public.user_role[]))
      or ((select public.has_any_role(array['tecnico', 'analista']::public.user_role[])) and p_stage.technician_id = (select auth.uid()));
$$;

revoke all on function public.repair_can_act(public.repair_stages) from public, anon, authenticated;

-- Pedir peça e pedir substituição (mesmos corpos da migration 46, com o analista).
create or replace function public.create_stock_request(p_serial text, p_part text, p_purpose text, p_qty integer default 1)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_stage public.repair_stages;
  v_part text := btrim(coalesce(p_part, ''));
  v_id uuid;
begin
  if not (select public.has_any_role(array['admin', 'tecnico', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_part = '' or char_length(v_part) > 60 or p_purpose not in ('teste', 'definitiva') or coalesce(p_qty, 0) not between 1 and 99 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  if p_purpose = 'teste' and p_qty <> 1 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;

  v_os := public.current_os(p_serial);
  select * into v_stage from public.repair_stages
   where os_id = v_os.id and status = 'em_andamento' order by started_at desc limit 1;

  insert into public.stock_requests (os_id, stage_id, origin_stage, serial, part, purpose, qty)
  values (v_os.id, v_stage.id, v_stage.stage, v_os.serial, v_part, p_purpose, p_qty)
  returning id into v_id;

  perform public.stock_log(v_id, null, 'solicitacao', p_qty, 0, jsonb_build_object('part', v_part, 'purpose', p_purpose), null);
  if v_stage.id is not null then
    perform public.repair_timer_part_wait(v_stage.id);
  end if;
  return v_id;
end;
$$;

create or replace function public.request_replacement(p_request_id uuid, p_qty integer default 1) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.stock_requests;
  v_stage public.repair_stages;
  v_new uuid;
  v_ret uuid;
  v_already integer;
begin
  if not (select public.has_any_role(array['admin', 'tecnico', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into r from public.stock_requests where id = p_request_id for update;
  if not found or r.purpose <> 'definitiva' or r.qty_delivered < 1 or coalesce(p_qty, 0) < 1 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select coalesce(sum(qty), 0) into v_already
    from public.stock_returns where request_id = r.id and reason = 'substituicao_defeito';
  if v_already + p_qty > r.qty_delivered then
    raise exception 'substituição acima do entregue' using errcode = 'P0001';
  end if;

  select * into v_stage from public.repair_stages
   where os_id = r.os_id and status = 'em_andamento' order by started_at desc limit 1;

  insert into public.stock_returns (request_id, os_id, serial, part, reason, qty)
  values (r.id, r.os_id, r.serial, r.part, 'substituicao_defeito', p_qty)
  returning id into v_ret;

  insert into public.stock_requests (os_id, stage_id, origin_stage, serial, part, purpose, qty, replaces_request_id)
  values (r.os_id, v_stage.id, v_stage.stage, r.serial, r.part, 'definitiva', p_qty, r.id)
  returning id into v_new;

  perform public.stock_log(r.id, v_ret, 'substituicao_solicitada', p_qty, 0, jsonb_build_object('substituta', v_new), null);
  perform public.stock_log(v_new, null, 'solicitacao', p_qty, 0,
    jsonb_build_object('part', r.part, 'purpose', 'definitiva', 'substitui', r.id), null);
  if v_stage.id is not null then
    perform public.repair_timer_part_wait(v_stage.id);
  end if;
  return v_new;
end;
$$;

revoke all on function public.create_stock_request(text, text, text, integer) from public, anon;
revoke all on function public.request_replacement(uuid, integer) from public, anon;
grant execute on function public.create_stock_request(text, text, text, integer) to authenticated;
grant execute on function public.request_replacement(uuid, integer) to authenticated;

-- Finalizar o reparo em placa (corpo da migration 62; "quarentena" agora abre a manutenção do analista).
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
  elsif p_destination = 'quarentena' then
    -- Sem outro reparo: o próprio analista faz os checklists e a montagem (aba Checklist e montagem) e finaliza;
    -- aprovado, o aparelho vai para a quarentena.
    select * into v_stage from public.repair_stages where os_id = q.os_id and stage = 'manutencao' and round = v_round;
    if not found then
      insert into public.repair_stages (os_id, serial, stage, technician_id, round)
      values (q.os_id, q.serial, 'manutencao', v_me, v_round)
      returning * into v_stage;
    else
      update public.repair_stages
         set status = 'em_andamento', finished_at = null, outcome = null, resale_reason = null, failed_tests = '[]'::jsonb,
             technician_id = v_me
       where id = v_stage.id
      returning * into v_stage;
    end if;
    update public.stock_requests set stage_id = v_stage.id
     where id in (select r.id from public.repair_analysis_parts(p_id) r);
    update public.repair_analysis_queue set board_checklist = true where id = p_id;
    v_out := v_stage.id;
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

-- O que foi enviado à quarentena. O reparo em placa só conta como envio direto nos registros antigos (sem manutenção
-- aberta depois dele); agora o envio acontece quando o analista finaliza a manutenção.
create or replace function public.repair_quarantine_sends()
returns table (os_id uuid, serial text, serial_key text, os_number text, os_created timestamptz, sender_id uuid, sent_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.os_id, s.serial, s.serial_key, o.os_number, o.created_at, s.technician_id, s.finished_at
  from public.repair_stages s
  join public.service_orders o on o.id = s.os_id
  where s.stage = 'manutencao' and s.status = 'concluida' and s.outcome = 'quarentena'
  union all
  select q.os_id, q.serial, q.serial_key, o.os_number, o.created_at, q.board_by, q.board_finished_at
  from public.repair_analysis_queue q
  join public.service_orders o on o.id = q.os_id
  where q.board_status = 'concluido' and q.board_destination = 'quarentena'
    and not q.board_checklist;
$$;

revoke all on function public.repair_quarantine_sends() from public, anon, authenticated;
