-- Análise técnica: o reparo em placa deixa de ser destino e vira uma das manutenções feitas ("Reparo em placa"), com a
-- observação do serviço feito. Rode depois de 20261008000112_analysis_board_self.sql. Pode rodar de novo.
--
--   * repair_stages.board_note: a observação do reparo em placa do checklist da análise.
--   * analysis_set_board_note: grava (ou limpa) a observação antes de finalizar.
--   * Ao finalizar o checklist da análise com a observação, o reparo em placa fica registrado na fila da análise
--     (result reparo_placa, board_*), como o Reparo em placa antigo: conta como placa de quem fez.
--   * analysis_board_repair (migration 112, destino Reparo em placa) sai.

alter table public.repair_stages add column if not exists board_note text;

drop function if exists public.analysis_board_repair(uuid, text, text[], text[], text[]);

create or replace function public.analysis_set_board_note(p_stage_id uuid, p_note text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or not coalesce(v_stage.analysis, false) or v_stage.status <> 'em_andamento'
     or (v_stage.technician_id <> (select auth.uid()) and not (select public.has_any_role(array['admin']::public.user_role[]))) then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) < 5 then
    raise exception 'board_note_required' using errcode = 'P0001';
  end if;
  update public.repair_stages set board_note = left(v_note, 1000) where id = v_stage.id;
end;
$$;

revoke all on function public.analysis_set_board_note(uuid, text) from public, anon;
grant execute on function public.analysis_set_board_note(uuid, text) to authenticated;

-- Gatilho do Dia Laboratório (corpo da migration 109) + o registro do reparo em placa da análise.
create or replace function public.lab_on_stage() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.lab_balloons;
  v_asset public.lab_assets;
  v_status text;
  v_id uuid;
  v_me uuid := coalesce((select auth.uid()), new.technician_id);
begin
  if new.stage <> 'manutencao' or not coalesce(new.legacy, false) then
    return null;
  end if;

  -- Checklist da Análise técnica: sem balão. Ao finalizar, fecha a fila da análise, registra o reparo em placa (se
  -- houve) e move o ativo do Dia Laboratório para o destino.
  if coalesce(new.analysis, false) then
    if tg_op = 'UPDATE' and new.status = 'concluida' and old.status is distinct from 'concluida' then
      if new.board_note is not null then
        update public.repair_analysis_queue
           set status = 'concluida', result = 'reparo_placa', finished_by = v_me, finished_at = now(),
               board_status = 'concluido', board_by = new.technician_id, board_started_at = coalesce(board_started_at, now()),
               board_finished_at = now(), board_note = new.board_note,
               board_destination = case when new.outcome in ('quarentena', 'vidro') then new.outcome end
         where os_id = new.os_id;
        if not found then
          insert into public.repair_analysis_queue (os_id, stage_id, serial, failed_tests, status, result, started_by, started_at,
                                                    finished_by, finished_at, board_status, board_by, board_started_at,
                                                    board_finished_at, board_note, board_destination)
          values (new.os_id, new.id, new.serial, '[]'::jsonb, 'concluida', 'reparo_placa', new.technician_id, now(), v_me, now(),
                  'concluido', new.technician_id, now(), now(), new.board_note,
                  case when new.outcome in ('quarentena', 'vidro') then new.outcome end);
        end if;
        perform public.repair_log(new.os_id, new.id, null, 'reparo_placa_concluido',
          jsonb_build_object('observacao', new.board_note, 'destino', new.outcome, 'pela', 'analise_checklist'));
      else
        update public.repair_analysis_queue
           set status = 'concluida', finished_by = v_me, finished_at = now()
         where os_id = new.os_id and status <> 'concluida';
      end if;
      select * into v_asset from public.lab_assets
       where serial_key = new.serial_key and exited_at is null and status = 'analise'
       for update;
      if found and new.outcome is distinct from 'analise' then
        v_status := public.lab_status_for(new.outcome);
        update public.lab_assets
           set status = v_status, last_move_at = now(),
               exited_at = case when v_status in ('pt', 'revenda', 'bloqueado') then now() end
         where id = v_asset.id;
        perform public.lab_log(v_asset.id, null, v_asset.serial, 'analise_finalizada', new.technician_id, null,
          jsonb_build_object('destino', new.outcome, 'reparo_placa', new.board_note));
      end if;
    end if;
    return null;
  end if;

  if new.status = 'em_andamento'
     and (tg_op = 'INSERT' or old.status is distinct from new.status or old.technician_id is distinct from new.technician_id) then
    select * into b from public.lab_balloons where serial_key = new.serial_key and status in ('pendente', 'aberto') for update;
    if found then
      if b.status = 'aberto' then
        if b.stage_id is distinct from new.id then
          update public.lab_balloons set stage_id = new.id where id = b.id;
        end if;
        if b.technician_id <> new.technician_id then
          update public.lab_balloons set technician_id = new.technician_id, confirmed_at = now() where id = b.id;
          update public.lab_assets set technician_id = new.technician_id, last_move_at = now() where id = b.asset_id;
          perform public.lab_log(b.asset_id, b.id, b.serial, 'responsavel_trocado', b.technician_id, new.technician_id);
        end if;
      end if;
    else
      select a.* into v_asset from public.lab_assets a
       where a.serial_key = new.serial_key and a.status = 'pt' and a.exited_at is not null
         and exists (select 1 from public.lab_balloons x where x.asset_id = a.id and x.stage_id = new.id)
         and not exists (select 1 from public.lab_assets o where o.serial_key = new.serial_key and o.exited_at is null)
       order by a.entered_at desc limit 1 for update;
      if found then
        update public.lab_assets set exited_at = null where id = v_asset.id;
        perform public.lab_log(v_asset.id, null, v_asset.serial, 'pt_recusado');
      else
        v_asset := public.lab_open_passage(new.serial);
      end if;
      v_id := public.lab_give(v_asset, new.technician_id, 'retorno', null, null, false, new.id);
      perform public.lab_log(v_asset.id, v_id, v_asset.serial, 'retorno', null, new.technician_id,
        jsonb_build_object('status_anterior', v_asset.status));
    end if;

  elsif tg_op = 'UPDATE' and new.status = 'concluida' and old.status is distinct from 'concluida' then
    select * into b from public.lab_balloons where stage_id = new.id and status in ('pendente', 'aberto') for update;
    if found then
      if b.status = 'pendente' then
        raise exception 'lab_transfer_pending' using errcode = 'P0001';
      end if;
      v_status := public.lab_status_for(new.outcome);
      update public.lab_balloons set status = 'finalizado', outcome = new.outcome, finished_at = now() where id = b.id;
      update public.lab_assets
         set status = v_status, technician_id = null, last_technician_id = b.technician_id, last_move_at = now(),
             exited_at = case when v_status in ('pt', 'revenda', 'bloqueado') then now() end
       where id = b.asset_id;
      perform public.lab_log(b.asset_id, b.id, b.serial, 'finalizacao', b.technician_id, null,
        jsonb_build_object('destino', new.outcome, 'manutencoes', new.maintenance_items));
    end if;
  end if;
  return null;
end;
$$;

revoke all on function public.lab_on_stage() from public, anon, authenticated;
