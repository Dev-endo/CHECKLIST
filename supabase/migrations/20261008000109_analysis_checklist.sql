-- Análise técnica como checklist: o analista bipa o serial e faz o mesmo checklist do Checklist manutenção (sem
-- balões), com os testes do aparelho aberto e fechado e o destino. Só o analista (e o admin) abre.
-- Rode depois de 20261008000108_lab_day.sql. Pode rodar de novo.
--
--   * repair_stages.analysis: o checklist foi feito na Análise técnica (não vira balão nem conta na meta do técnico).
--   * start_analysis_checklist / take_analysis_checklist: abrir (ou assumir do zero) o checklist da análise.
--   * Ao finalizar: a fila da Análise técnica do aparelho é fechada (se o destino não for a própria análise) e, no
--     Dia Laboratório, o ativo sai de "Aguardando análise técnica" para o destino escolhido.

alter table public.repair_stages add column if not exists analysis boolean not null default false;

-- Abre (ou retoma) o checklist da Análise técnica. O ativo que está no balão de um técnico segue com ele.
create or replace function public.start_analysis_checklist(p_serial text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_round integer;
  v_stage public.repair_stages;
  v_me uuid := (select auth.uid());
  v_holder uuid;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select b.technician_id into v_holder from public.lab_balloons b
   where b.serial_key = lower(btrim(coalesce(p_serial, ''))) and b.status in ('pendente', 'aberto');
  if v_holder is not null then
    raise exception 'lab_in_balloon' using errcode = 'P0001', detail = coalesce(public.lab_name(v_holder), 'um técnico');
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
      if v_stage.technician_id is distinct from v_me
         and not (select public.has_any_role(array['admin']::public.user_role[])) then
        raise exception 'legacy_other_owner' using errcode = 'P0001',
          detail = coalesce(public.lab_name(v_stage.technician_id), 'outro técnico');
      end if;
      return v_stage.id;
    end if;
    v_round := v_round + 1;
  end if;

  insert into public.repair_stages (os_id, serial, stage, technician_id, round, legacy, analysis)
  values (v_os.id, v_os.serial, 'manutencao', v_me, v_round, true, true)
  returning * into v_stage;
  perform public.repair_log(v_os.id, v_stage.id, null, 'checklist_analise_iniciado');
  return v_stage.id;
end;
$$;

revoke all on function public.start_analysis_checklist(text) from public, anon;
grant execute on function public.start_analysis_checklist(text) to authenticated;

-- "Fazer um novo, do zero": o checklist da análise começado por outro analista passa para quem bipou, em branco.
-- Só vale para checklists da análise (o de um técnico segue com ele).
create or replace function public.take_analysis_checklist(p_serial text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_round integer;
  v_stage public.repair_stages;
  v_old jsonb;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  v_os := public.current_os(p_serial);
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = v_os.id;
  select * into v_stage from public.repair_stages
   where os_id = v_os.id and stage = 'manutencao' and round = v_round and legacy and status = 'em_andamento'
   for update;
  if not found or not v_stage.analysis then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  if v_stage.technician_id = (select auth.uid()) then
    return v_stage.id;
  end if;

  select coalesce(jsonb_object_agg(phase, results), '{}'::jsonb) into v_old
    from public.repair_checklist_results where stage_id = v_stage.id;
  delete from public.repair_checklist_results where stage_id = v_stage.id;
  update public.repair_stages set technician_id = (select auth.uid()), started_at = now() where id = v_stage.id;
  perform public.repair_log(v_os.id, v_stage.id, null, 'checklist_analise_assumido',
    jsonb_build_object('tecnico_anterior', v_stage.technician_id, 'marcacoes_anteriores', v_old));
  return v_stage.id;
end;
$$;

revoke all on function public.take_analysis_checklist(text) from public, anon;
grant execute on function public.take_analysis_checklist(text) to authenticated;

-- Gatilho do Dia Laboratório (corpo da migration 108) + o checklist da análise, que não vira balão.
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
begin
  if new.stage <> 'manutencao' or not coalesce(new.legacy, false) then
    return null;
  end if;

  -- Checklist da Análise técnica: sem balão. Ao finalizar, fecha a fila da análise e move o ativo para o destino.
  if coalesce(new.analysis, false) then
    if tg_op = 'UPDATE' and new.status = 'concluida' and old.status is distinct from 'concluida' then
      update public.repair_analysis_queue
         set status = 'concluida', finished_by = (select auth.uid()), finished_at = now()
       where os_id = new.os_id and status <> 'concluida';
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
          jsonb_build_object('destino', new.outcome));
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

-- Transferir para técnico (destino do checklist da análise): o ativo vira um balão pendente do técnico escolhido, com
-- o checklist e as marcações; ele confirma o recebimento e continua de onde o analista parou.
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
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or not coalesce(v_stage.analysis, false) or v_stage.status <> 'em_andamento'
     or (v_stage.technician_id <> v_me and not (select public.has_any_role(array['admin']::public.user_role[]))) then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  if p_technician is null or p_technician = v_me or not public.lab_is_technician(p_technician) then
    raise exception 'lab_technician_invalid' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.lab_balloons b where b.serial_key = v_stage.serial_key and b.status in ('pendente', 'aberto')) then
    raise exception 'lab_serial_taken' using errcode = 'P0001', detail = v_stage.serial;
  end if;

  select coalesce(jsonb_object_agg(r.phase, r.results), '{}'::jsonb) into v_marks
    from public.repair_checklist_results r where r.stage_id = v_stage.id;

  -- A análise do aparelho termina aqui (o técnico segue com o checklist).
  update public.repair_analysis_queue
     set status = 'concluida', finished_by = v_me, finished_at = now()
   where os_id = v_stage.os_id and status <> 'concluida';

  v_asset := public.lab_open_passage(v_stage.serial);
  v_balloon := public.lab_give(v_asset, p_technician, 'transferencia', v_me, p_note, true, v_stage.id);
  -- Deixa de ser checklist da análise: a partir daqui vale a regra dos balões (pendente não é trabalhado).
  update public.repair_stages set analysis = false where id = v_stage.id;

  perform public.lab_log(v_asset.id, v_balloon, v_asset.serial, 'transferencia', v_me, p_technician,
    jsonb_build_object('por', 'analise', 'checklist', v_stage.id, 'marcacoes', v_marks,
                       'motivo', nullif(btrim(coalesce(p_note, '')), ''), 'status_anterior', v_asset.status));
  perform public.repair_log(v_stage.os_id, v_stage.id, null, 'analise_transferida',
    jsonb_build_object('para', p_technician, 'motivo', nullif(btrim(coalesce(p_note, '')), '')));
  return v_balloon;
end;
$$;

revoke all on function public.analysis_transfer(uuid, uuid, text) from public, anon;
grant execute on function public.analysis_transfer(uuid, uuid, text) to authenticated;

-- O analista também escolhe o técnico (corpo da migration 108 + analista).
create or replace function public.lab_technicians() returns table (id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, coalesce(nullif(btrim(p.name), ''), p.email)
    from public.profiles p
   where (select public.has_any_role(array['admin', 'supervisor', 'tecnico', 'tecnico_vidro', 'analista']::public.user_role[]))
     and (p.role in ('tecnico', 'admin') or p.extra_roles && array['tecnico', 'admin']::public.user_role[])
   order by 2;
$$;

revoke all on function public.lab_technicians() from public, anon;
grant execute on function public.lab_technicians() to authenticated;
