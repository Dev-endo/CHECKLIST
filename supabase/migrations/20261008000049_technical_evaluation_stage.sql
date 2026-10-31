-- Reparo: nova fase "avaliação técnica" entre a desmontagem e a manutenção (Estágio 2).
-- Rode depois de 20261008000048_stock_requests_compat_view.sql. Pode rodar de novo.
--
-- Fluxo: desmontagem -> avaliacao -> manutencao.
--   * Concluir a desmontagem abre a avaliação técnica (mesmo técnico, mesma OS) e já liga o cronômetro dela.
--   * Pedir peça pausa só o cronômetro da fase em andamento (espera de peça); o técnico retoma quando quiser.
--   * Concluir a avaliação técnica abre a manutenção. Os pedidos em aberto acompanham o aparelho.
--   * A manutenção só finaliza com a avaliação concluída (OS antigas, sem avaliação, seguem como estavam).

alter table public.repair_stages drop constraint if exists repair_stages_stage_check;
alter table public.repair_stages
  add constraint repair_stages_stage_check check (stage in ('desmontagem', 'avaliacao', 'manutencao'));

alter table public.stock_requests drop constraint if exists stock_requests_origin_stage_check;
alter table public.stock_requests
  add constraint stock_requests_origin_stage_check check (origin_stage in ('desmontagem', 'avaliacao', 'manutencao'));

-- Concluir a desmontagem (pode haver pedidos em aberto). Devolve o id da avaliação técnica, já com o cronômetro ligado.
create or replace function public.finish_disassembly(p_stage_id uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
  v_next uuid;
  v_created boolean := false;
begin
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'desmontagem' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;

  perform public.repair_timer_switch(p_stage_id, null);
  update public.repair_stages set status = 'concluida', finished_at = now() where id = p_stage_id;

  insert into public.repair_stages (os_id, serial, stage, technician_id)
  values (v_stage.os_id, v_stage.serial, 'avaliacao', v_stage.technician_id)
  on conflict (os_id, stage) do nothing
  returning id into v_next;
  if v_next is null then
    select id into v_next from public.repair_stages where os_id = v_stage.os_id and stage = 'avaliacao';
  else
    v_created := true;
  end if;

  -- A avaliação começa a contar assim que a desmontagem termina.
  if v_created then
    perform public.repair_timer_switch(v_next, 'produtivo');
  end if;

  update public.stock_requests set stage_id = v_next
   where os_id = v_stage.os_id and status in ('pendente', 'em_separacao', 'sem_estoque') and stage_id = p_stage_id;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'desmontagem_concluida', jsonb_build_object('proxima_etapa', v_next));
  return v_next;
end;
$$;

-- Concluir a avaliação técnica: abre a manutenção (Estágio 2) e devolve o id dela.
create or replace function public.finish_evaluation(p_stage_id uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
  v_next uuid;
begin
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'avaliacao' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;

  perform public.repair_timer_switch(p_stage_id, null);
  update public.repair_stages set status = 'concluida', finished_at = now() where id = p_stage_id;

  insert into public.repair_stages (os_id, serial, stage, technician_id)
  values (v_stage.os_id, v_stage.serial, 'manutencao', v_stage.technician_id)
  on conflict (os_id, stage) do nothing
  returning id into v_next;
  if v_next is null then
    select id into v_next from public.repair_stages where os_id = v_stage.os_id and stage = 'manutencao';
  end if;

  update public.stock_requests set stage_id = v_next
   where os_id = v_stage.os_id and status in ('pendente', 'em_separacao', 'sem_estoque') and stage_id = p_stage_id;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'avaliacao_concluida', jsonb_build_object('proxima_etapa', v_next));
  return v_next;
end;
$$;

-- A manutenção só finaliza com a desmontagem e a avaliação técnica (quando existe) concluídas.
create or replace function public.finish_maintenance(
  p_stage_id uuid, p_required_open text[], p_required_closed text[],
  p_resale boolean default false, p_resale_reason text default null
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
begin
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'manutencao' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
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

  foreach v_id in array coalesce(p_required_open, '{}') loop
    if coalesce(v_open ->> v_id, '') not in ('ok', 'fail') then
      raise exception 'tests_pending' using errcode = 'P0001';
    end if;
  end loop;
  foreach v_id in array coalesce(p_required_closed, '{}') loop
    if coalesce(v_closed ->> v_id, '') not in ('ok', 'fail') then
      raise exception 'tests_pending' using errcode = 'P0001';
    end if;
  end loop;

  v_blockers := public.repair_finish_blockers(v_stage.os_id);
  if array_length(v_blockers, 1) > 0 then
    raise exception '%', v_blockers[1] using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('fase', f.phase, 'teste', f.key) order by f.phase, f.key), '[]')
    into v_failed
    from (
      select 'aberto' as phase, e.key from jsonb_each_text(v_open) e where e.value = 'fail'
      union all
      select 'fechado', e.key from jsonb_each_text(v_closed) e where e.value = 'fail'
    ) f;

  if p_resale then
    if char_length(v_reason) < 5 then
      raise exception 'resale_reason_required' using errcode = 'P0001';
    end if;
    v_outcome := 'revenda';
  elsif jsonb_array_length(v_failed) > 0 then
    v_outcome := 'analise';
  else
    v_outcome := 'quarentena';
  end if;

  perform public.repair_timer_switch(p_stage_id, null);
  update public.repair_stages
     set status = 'concluida', finished_at = now(), outcome = v_outcome, failed_tests = v_failed,
         resale_reason = case when v_outcome = 'revenda' then v_reason end
   where id = p_stage_id;

  if jsonb_array_length(v_failed) > 0 then
    insert into public.repair_analysis_queue (os_id, stage_id, serial, failed_tests)
    values (v_stage.os_id, p_stage_id, v_stage.serial, v_failed)
    on conflict (os_id) do update set failed_tests = excluded.failed_tests, stage_id = excluded.stage_id;
  end if;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'manutencao_finalizada',
    jsonb_build_object('destino', v_outcome, 'reprovados', v_failed, 'justificativa_revenda', nullif(v_reason, '')));
  return v_outcome;
end;
$$;

revoke all on function public.finish_disassembly(uuid) from public, anon;
revoke all on function public.finish_evaluation(uuid) from public, anon;
revoke all on function public.finish_maintenance(uuid, text[], text[], boolean, text) from public, anon;
grant execute on function public.finish_disassembly(uuid) to authenticated;
grant execute on function public.finish_evaluation(uuid) to authenticated;
grant execute on function public.finish_maintenance(uuid, text[], text[], boolean, text) to authenticated;
