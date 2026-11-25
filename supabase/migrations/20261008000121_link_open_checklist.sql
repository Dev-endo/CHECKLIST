-- Dia Laboratório: o checklist que já estava aberto antes do balão não fechava o balão ao finalizar (o ativo seguia
-- "na bancada" e não contava na meta, ex.: enviado para o vidro). Rode depois de 20261008000120_lab_reassign.sql.
-- Pode rodar de novo.
--
--   * start_legacy_maintenance (corpo da migration 110): ao retomar um checklist aberto, liga-o ao balão do ativo.
--   * lab_on_stage (corpo da migration 115): ao finalizar, sem balão ligado ao checklist, fecha o balão aberto do serial.
--   * Conserto de dados: liga os balões abertos aos checklists abertos do serial e fecha os balões abertos cujo
--     checklist do serial já foi finalizado depois da entrega (com o destino e o horário do checklist).

create or replace function public.start_legacy_maintenance(p_serial text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_round integer;
  v_stage public.repair_stages;
  v_me uuid := (select auth.uid());
  v_admin boolean := (select public.has_any_role(array['admin']::public.user_role[]));
  v_balloon public.lab_balloons;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  -- Transferência do Dia Laboratório aguardando quem recebeu confirmar.
  select * into v_balloon from public.lab_balloons
   where serial_key = lower(btrim(coalesce(p_serial, ''))) and status in ('pendente', 'aberto');
  if found and v_balloon.status = 'pendente' then
    raise exception 'lab_transfer_pending' using errcode = 'P0001';
  end if;

  v_os := public.current_os(p_serial);
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = v_os.id;

  if exists (select 1 from public.repair_stages
              where os_id = v_os.id and round = v_round and stage in ('desmontagem', 'avaliacao') and status <> 'concluida') then
    raise exception 'disassembly_open' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.repair_pt_requests where os_id = v_os.id and status = 'pendente') then
    raise exception 'pt_pending' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.repair_glass_jobs where os_id = v_os.id and status <> 'concluido') then
    raise exception 'in_glass' using errcode = 'P0001';
  end if;

  select * into v_stage from public.repair_stages where os_id = v_os.id and stage = 'manutencao' and round = v_round;
  if found then
    if v_stage.status <> 'concluida' then
      if not v_stage.legacy then
        raise exception 'in_repair' using errcode = 'P0001';
      end if;
      if v_stage.technician_id is distinct from v_me and not v_admin then
        raise exception 'legacy_other_owner' using errcode = 'P0001',
          detail = coalesce(public.lab_name(v_stage.technician_id), 'outro técnico');
      end if;
      -- Checklist que já estava aberto: fica ligado ao balão do ativo (para fechar o balão ao finalizar).
      update public.lab_balloons set stage_id = v_stage.id
       where serial_key = v_os.serial_key and status in ('pendente', 'aberto') and stage_id is null;
      return v_stage.id;
    end if;
    v_round := v_round + 1;
  end if;

  -- O checklist é de quem bipou (o admin, abrindo o balão de outro técnico, abre para o dono do balão).
  insert into public.repair_stages (os_id, serial, stage, technician_id, round, legacy)
  values (v_os.id, v_os.serial, 'manutencao',
          case when v_admin and v_balloon.id is not null then v_balloon.technician_id else v_me end, v_round, true)
  returning * into v_stage;
  perform public.repair_log(v_os.id, v_stage.id, null, 'checklist_manutencao_iniciado');
  return v_stage.id;
end;
$$;

revoke all on function public.start_legacy_maintenance(text) from public, anon;
grant execute on function public.start_legacy_maintenance(text) to authenticated;

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

  -- A passagem aberta do ativo fica com a OS do checklist (quando ainda não tinha).
  if new.status = 'em_andamento' then
    update public.lab_assets set os_id = new.os_id
     where serial_key = new.serial_key and exited_at is null and os_id is null;
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
    -- O balão do checklist; sem ligação (checklist aberto antes do balão), o balão aberto do mesmo serial.
    select * into b from public.lab_balloons
     where status in ('pendente', 'aberto')
       and (stage_id = new.id or (stage_id is null and serial_key = new.serial_key))
     order by (stage_id = new.id) desc nulls last
     limit 1
     for update;
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

-- Conserto de dados ---------------------------------------------------------------------------------------------------
-- 1) Balão aberto sem checklist, com um checklist aberto do serial: liga.
update public.lab_balloons b
   set stage_id = st.id
  from public.repair_stages st
 where b.status in ('pendente', 'aberto') and b.stage_id is null
   and st.serial_key = b.serial_key and st.stage = 'manutencao' and st.legacy and st.status = 'em_andamento'
   and not coalesce(st.analysis, false);

-- 2) Balão aberto cujo checklist do serial já foi finalizado depois da entrega: fecha com o destino do checklist.
do $$
declare
  r record;
  v_status text;
begin
  for r in
    select b.id as balloon_id, b.asset_id, b.serial, b.technician_id, st.id as stage_id, st.outcome, st.finished_at,
           st.maintenance_items
      from public.lab_balloons b
      join lateral (
        select s.* from public.repair_stages s
         where s.serial_key = b.serial_key and s.stage = 'manutencao' and s.legacy and s.status = 'concluida'
           and s.finished_at >= b.created_at and not coalesce(s.analysis, false)
         order by s.finished_at desc limit 1
      ) st on true
     where b.status = 'aberto' and b.stage_id is null
  loop
    v_status := public.lab_status_for(r.outcome);
    update public.lab_balloons
       set status = 'finalizado', outcome = r.outcome, finished_at = r.finished_at, stage_id = r.stage_id
     where id = r.balloon_id;
    update public.lab_assets
       set status = v_status, technician_id = null, last_technician_id = r.technician_id, last_move_at = r.finished_at,
           exited_at = case when v_status in ('pt', 'revenda', 'bloqueado') then r.finished_at end
     where id = r.asset_id;
    perform public.lab_log(r.asset_id, r.balloon_id, r.serial, 'finalizacao', r.technician_id, null,
      jsonb_build_object('destino', r.outcome, 'manutencoes', r.maintenance_items, 'conserto', 'migration 121'));
  end loop;
end;
$$;
