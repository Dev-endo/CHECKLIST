-- Análise técnica (checklist): destino "Reparo em placa" com a observação do serviço feito, e "Transferir para
-- técnico" também para si mesmo. Rode depois de 20261008000111_glass_send_admin.sql. Pode rodar de novo.
--
--   * analysis_board_repair: finaliza o checklist da análise como reparo em placa. Os testes valem como no destino
--     Quarentena (aprovado vai para a quarentena; com teste reprovado volta para a fila da análise, com a observação).
--     Aprovado, o reparo em placa fica registrado na fila da análise (result reparo_placa, board_*), como o Reparo em
--     placa antigo: conta como placa para quem fez.
--   * analysis_transfer: transferir para si mesmo vira um balão já aberto (sem confirmação).

create or replace function public.analysis_board_repair(p_stage_id uuid, p_note text, p_required_open text[],
                                                        p_required_closed text[], p_choice text[] default '{}')
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_stage public.repair_stages;
  v_note text := btrim(coalesce(p_note, ''));
  v_outcome text;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id;
  if not found or not coalesce(v_stage.analysis, false) or v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  if char_length(v_note) < 5 then
    raise exception 'board_note_required' using errcode = 'P0001';
  end if;

  -- O mesmo fim do destino Quarentena (o banco confere os testes); reprovado, a observação vai como motivo da análise.
  v_outcome := public.finish_maintenance(p_stage_id, p_required_open, p_required_closed, false, null, coalesce(p_choice, '{}'),
                                         p_analysis_note => v_note);

  if v_outcome = 'quarentena' then
    update public.repair_analysis_queue
       set status = 'concluida', result = 'reparo_placa', finished_by = coalesce(finished_by, v_me), finished_at = coalesce(finished_at, now()),
           board_status = 'concluido', board_by = v_me, board_started_at = coalesce(board_started_at, now()),
           board_finished_at = now(), board_note = left(v_note, 1000), board_destination = 'quarentena'
     where os_id = v_stage.os_id;
    if not found then
      insert into public.repair_analysis_queue (os_id, stage_id, serial, failed_tests, status, result, started_by, started_at,
                                                finished_by, finished_at, board_status, board_by, board_started_at,
                                                board_finished_at, board_note, board_destination)
      values (v_stage.os_id, v_stage.id, v_stage.serial, '[]'::jsonb, 'concluida', 'reparo_placa', v_me, now(), v_me, now(),
              'concluido', v_me, now(), now(), left(v_note, 1000), 'quarentena');
    end if;
  end if;

  perform public.repair_log(v_stage.os_id, v_stage.id, null, 'reparo_placa_concluido',
    jsonb_build_object('observacao', v_note, 'destino', v_outcome, 'pela', 'analise_checklist'));
  return v_outcome;
end;
$$;

revoke all on function public.analysis_board_repair(uuid, text, text[], text[], text[]) from public, anon;
grant execute on function public.analysis_board_repair(uuid, text, text[], text[], text[]) to authenticated;

-- Transferir para técnico (corpo da migration 109): para si mesmo, o balão já nasce aberto.
create or replace function public.analysis_transfer(p_stage_id uuid, p_technician uuid, p_note text default null) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_stage public.repair_stages;
  v_asset public.lab_assets;
  v_balloon uuid;
  v_marks jsonb;
  v_self boolean := p_technician = v_me;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or not coalesce(v_stage.analysis, false) or v_stage.status <> 'em_andamento'
     or (v_stage.technician_id <> v_me and not (select public.has_any_role(array['admin']::public.user_role[]))) then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  if p_technician is null or not public.lab_is_technician(p_technician) then
    raise exception 'lab_technician_invalid' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.lab_balloons b where b.serial_key = v_stage.serial_key and b.status in ('pendente', 'aberto')) then
    raise exception 'lab_serial_taken' using errcode = 'P0001', detail = v_stage.serial;
  end if;

  select coalesce(jsonb_object_agg(r.phase, r.results), '{}'::jsonb) into v_marks
    from public.repair_checklist_results r where r.stage_id = v_stage.id;

  update public.repair_analysis_queue
     set status = 'concluida', finished_by = v_me, finished_at = now()
   where os_id = v_stage.os_id and status <> 'concluida';

  v_asset := public.lab_open_passage(v_stage.serial);
  v_balloon := public.lab_give(v_asset, p_technician, 'transferencia', v_me, p_note, not v_self, v_stage.id);
  update public.repair_stages set analysis = false where id = v_stage.id;
  -- Para outra pessoa, o checklist passa a ela na confirmação; para si mesmo, já é seu.
  if v_self and v_stage.technician_id <> v_me then
    update public.repair_stages set technician_id = v_me where id = v_stage.id;
  end if;

  perform public.lab_log(v_asset.id, v_balloon, v_asset.serial, 'transferencia', v_me, p_technician,
    jsonb_build_object('por', 'analise', 'checklist', v_stage.id, 'marcacoes', v_marks, 'para_si', v_self,
                       'motivo', nullif(btrim(coalesce(p_note, '')), ''), 'status_anterior', v_asset.status));
  perform public.repair_log(v_stage.os_id, v_stage.id, null, 'analise_transferida',
    jsonb_build_object('para', p_technician, 'motivo', nullif(btrim(coalesce(p_note, '')), '')));
  return v_balloon;
end;
$$;

revoke all on function public.analysis_transfer(uuid, uuid, text) from public, anon;
grant execute on function public.analysis_transfer(uuid, uuid, text) to authenticated;
