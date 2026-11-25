-- Checklist: "Vidro e outra manutenção" só vai para o vidro depois do checklist com o aparelho aberto; e a
-- transferência guarda as manutenções feitas por quem transferiu. Rode depois de 20261008000115_lab_passage_os.sql.
-- Pode rodar de novo.
--
--   * finish_maintenance (corpo da migration 114): destino Vidro com needs_glass exige o checklist aberto.
--   * lab_transfer (108) e analysis_transfer (112): o histórico da transferência leva as manutenções informadas.

create or replace function public.finish_maintenance(
  p_stage_id uuid, p_required_open text[], p_required_closed text[],
  p_resale boolean default false, p_resale_reason text default null, p_choice text[] default '{}',
  p_glass boolean default false, p_analysis boolean default false, p_analysis_note text default null,
  p_pt boolean default false, p_blocked boolean default false, p_quarantine boolean default false
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
  v_open jsonb;
  v_closed jsonb;
  v_id text;
  v_failed jsonb := '[]'::jsonb;
  v_blockers text[];
  v_outcome text;
  v_reason text := btrim(coalesce(p_resale_reason, ''));
  v_choice text[] := coalesce(p_choice, '{}');
  v_has_failure boolean;
  v_items jsonb;
  v_note text := btrim(coalesce(p_analysis_note, ''));
  v_skip_tests boolean;
begin
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'manutencao' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  if (p_resale::int + p_glass::int + p_analysis::int + p_pt::int + coalesce(p_blocked, false)::int + coalesce(p_quarantine, false)::int) > 1 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.repair_stages
     where os_id = v_stage.os_id and stage in ('desmontagem', 'avaliacao') and status <> 'concluida'
  ) then
    raise exception 'disassembly_open' using errcode = 'P0001';
  end if;

  select coalesce(results, '{}') into v_open from public.repair_checklist_results where stage_id = p_stage_id and phase = 'aberto';
  select coalesce(results, '{}') into v_closed from public.repair_checklist_results where stage_id = p_stage_id and phase = 'fechado';
  v_open := coalesce(v_open, '{}');
  v_closed := coalesce(v_closed, '{}');

  -- PT e Bloqueado não exigem o checklist. Vidro só dispensa quando é "só vidro": em "vidro e outra manutenção"
  -- (needs_glass) o checklist com o aparelho aberto é obrigatório (o fechado fica para depois do vidro).
  v_skip_tests := (p_glass and not coalesce(v_stage.needs_glass, false)) or p_pt or coalesce(p_blocked, false);

  foreach v_id in array (case when v_skip_tests then '{}'::text[] else coalesce(p_required_open, '{}') end) loop
    if coalesce(v_open ->> v_id, '') not in ('ok', 'fail') then
      raise exception 'tests_pending' using errcode = 'P0001';
    end if;
  end loop;
  foreach v_id in array (case when v_skip_tests then '{}'::text[] else coalesce(p_required_closed, '{}') end) loop
    if coalesce(v_closed ->> v_id, '') not in ('ok', 'fail') then
      raise exception 'tests_pending' using errcode = 'P0001';
    end if;
  end loop;

  v_blockers := public.repair_finish_blockers(v_stage.os_id);
  if array_length(v_blockers, 1) > 0 then
    raise exception '%', v_blockers[1] using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(f.entry order by f.ord, f.phase, f.k), '[]')
    into v_failed
    from (
      select 1 as ord, 'aberto' as phase, t as k, jsonb_build_object('fase', 'aberto', 'teste', t) as entry
        from unnest(coalesce(p_required_open, '{}')) t
       where v_open ->> t = 'fail' and t <> all (v_choice)
      union all
      select 1, 'fechado', t, jsonb_build_object('fase', 'fechado', 'teste', t)
        from unnest(coalesce(p_required_closed, '{}')) t
       where v_closed ->> t = 'fail' and t <> all (v_choice)
      union all
      select 2, 'aberto', e.key, jsonb_build_object('fase', 'aberto', 'item', e.key)
        from jsonb_each_text(v_open) e
       where e.value = 'fail' and e.key <> all (coalesce(p_required_open, '{}'))
         and exists (select 1 from unnest(coalesce(p_required_open, '{}')) t where v_open ->> t = 'fail' and t <> all (v_choice))
      union all
      select 2, 'fechado', e.key, jsonb_build_object('fase', 'fechado', 'item', e.key)
        from jsonb_each_text(v_closed) e
       where e.value = 'fail' and e.key <> all (coalesce(p_required_closed, '{}'))
         and exists (select 1 from unnest(coalesce(p_required_closed, '{}')) t where v_closed ->> t = 'fail' and t <> all (v_choice))
    ) f;

  v_has_failure := not v_skip_tests and exists (select 1 from jsonb_array_elements(v_failed) x where x ? 'teste');
  if not v_has_failure then
    v_failed := '[]'::jsonb;
  end if;

  if coalesce(p_blocked, false) then
    if char_length(v_reason) < 5 then
      raise exception 'blocked_reason_required' using errcode = 'P0001';
    end if;
    v_outcome := 'bloqueado';
  elsif p_pt then
    if char_length(v_reason) < 5 then
      raise exception 'pt_reason_required' using errcode = 'P0001';
    end if;
    v_outcome := 'pt';
  elsif p_resale then
    if char_length(v_reason) < 5 then
      raise exception 'resale_reason_required' using errcode = 'P0001';
    end if;
    v_outcome := 'revenda';
  elsif p_glass then
    v_outcome := 'vidro';
  elsif coalesce(p_quarantine, false) then
    -- Quarentena escolhida: vai para a quarentena mesmo com teste reprovado (a falha fica registrada).
    v_outcome := 'quarentena';
  elsif p_analysis or v_has_failure then
    v_outcome := 'analise';
  else
    v_outcome := 'quarentena';
  end if;
  -- Indo para a Análise técnica: o técnico explica o motivo.
  if v_outcome = 'analise' and char_length(v_note) < 5 then
    raise exception 'analysis_note_required' using errcode = 'P0001';
  end if;

  -- Manutenções que contam para quem finaliza: a placa que ele mesmo reparou e cada peça usada de vez.
  v_items := public.repair_maintenance_items(p_stage_id);

  perform public.repair_timer_switch(p_stage_id, null);
  update public.repair_stages
     set status = 'concluida', finished_at = now(), outcome = v_outcome, failed_tests = v_failed,
         resale_reason = case when v_outcome in ('revenda', 'pt', 'bloqueado') then v_reason end,
         maintenance_items = v_items,
         maintenance_count = (select coalesce(sum(coalesce((i ->> 'qtd')::integer, 1)), 0) from jsonb_array_elements(v_items) i)
   where id = p_stage_id;

  if v_outcome = 'pt' then
    -- PT: fica pendente até um administrador ou supervisor aprovar (reprovado, volta para o técnico).
    insert into public.repair_pt_requests (os_id, stage_id, serial, reason, requested_by)
    values (v_stage.os_id, p_stage_id, v_stage.serial, left(v_reason, 1000), (select auth.uid()));
  elsif v_outcome = 'vidro' then
    -- O aparelho volta para este técnico depois do vidro (a aba Vidro reabre a manutenção).
    perform public.repair_open_glass(v_stage, 'manutencao', v_stage.technician_id);
  elsif (v_has_failure and v_outcome <> 'quarentena') or v_outcome = 'analise' then
    -- Análise (reprovado ou escolhida) ou revenda com reprovação: a fila guarda o que falhou.
    insert into public.repair_analysis_queue (os_id, stage_id, serial, failed_tests, send_note)
    values (v_stage.os_id, p_stage_id, v_stage.serial, v_failed, case when v_outcome = 'analise' then left(v_note, 1000) end)
    on conflict (os_id) do update
      set failed_tests = excluded.failed_tests, stage_id = excluded.stage_id, send_note = excluded.send_note;
  end if;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'manutencao_finalizada',
    jsonb_build_object('destino', v_outcome, 'reprovados', v_failed, 'justificativa_revenda', case when v_outcome = 'revenda' then nullif(v_reason, '') end,
      'motivo_pt', case when v_outcome = 'pt' then nullif(v_reason, '') end,
      'motivo_bloqueio', case when v_outcome = 'bloqueado' then nullif(v_reason, '') end,
      'manutencoes', v_items, 'motivo_analise', case when v_outcome = 'analise' then nullif(v_note, '') end));
  return v_outcome;
end;
$$;
revoke all on function public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean, boolean, text, boolean, boolean, boolean) from public, anon;
grant execute on function public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean, boolean, text, boolean, boolean, boolean) to authenticated;

create or replace function public.lab_transfer(p_balloon uuid, p_technician uuid, p_note text default null) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  b public.lab_balloons;
  v_asset public.lab_assets;
  v_new uuid;
  v_marks jsonb;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into b from public.lab_balloons where id = p_balloon for update;
  if not found or b.status <> 'aberto'
     or (b.technician_id <> v_me and not (select public.has_any_role(array['admin']::public.user_role[]))) then
    raise exception 'lab_balloon_closed' using errcode = 'P0001';
  end if;
  if p_technician is null or p_technician = b.technician_id or not public.lab_is_technician(p_technician) then
    raise exception 'lab_technician_invalid' using errcode = 'P0001';
  end if;

  -- O que já foi preenchido fica no histórico.
  if b.stage_id is not null then
    select coalesce(jsonb_object_agg(r.phase, r.results), '{}'::jsonb) into v_marks
      from public.repair_checklist_results r where r.stage_id = b.stage_id;
  end if;

  update public.lab_balloons
     set status = 'transferido', outcome = 'transferido', finished_at = now(), transferred_to = p_technician
   where id = b.id;
  select * into v_asset from public.lab_assets where id = b.asset_id for update;
  v_new := public.lab_give(v_asset, p_technician, 'transferencia', b.technician_id, p_note, true, b.stage_id);
  update public.lab_assets set last_technician_id = b.technician_id where id = v_asset.id;
  perform public.lab_log(v_asset.id, v_new, v_asset.serial, 'transferencia', b.technician_id, p_technician,
    jsonb_build_object('balao_anterior', b.id, 'checklist', b.stage_id, 'marcacoes', v_marks,
                       'manutencoes', (select st.declared_items from public.repair_stages st where st.id = b.stage_id),
                       'motivo', nullif(btrim(coalesce(p_note, '')), '')));
  return v_new;
end;
$$;
revoke all on function public.lab_transfer(uuid, uuid, text) from public, anon;
grant execute on function public.lab_transfer(uuid, uuid, text) to authenticated;

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
                       'manutencoes', v_stage.declared_items,
                       'motivo', nullif(btrim(coalesce(p_note, '')), ''), 'status_anterior', v_asset.status));
  perform public.repair_log(v_stage.os_id, v_stage.id, null, 'analise_transferida',
    jsonb_build_object('para', p_technician, 'motivo', nullif(btrim(coalesce(p_note, '')), '')));
  return v_balloon;
end;
$$;
revoke all on function public.analysis_transfer(uuid, uuid, text) from public, anon;
grant execute on function public.analysis_transfer(uuid, uuid, text) to authenticated;
