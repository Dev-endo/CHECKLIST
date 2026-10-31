-- MVP Reparo, banco 4/5: Estágio 1 -> Estágio 2, checklists e regras de finalização da manutenção.
-- Rode depois de 20261008000046_stock_request_functions.sql. Pode rodar de novo.
--
-- Erros (P0001, mensagem): no_os; stage_not_found; stage_closed; disassembly_open; tests_pending;
-- request_pending; test_destiny_missing; return_unconfirmed; resale_reason_required.

-- Técnico: abre o Estágio 1 (desmontagem) na OS atual do serial. Repetir devolve a mesma etapa.
create or replace function public.start_disassembly(p_serial text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_id uuid;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  v_os := public.current_os(p_serial);

  insert into public.repair_stages (os_id, serial, stage, technician_id)
  values (v_os.id, v_os.serial, 'desmontagem', (select auth.uid()))
  on conflict (os_id, stage) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.repair_stages where os_id = v_os.id and stage = 'desmontagem';
  else
    perform public.repair_log(v_os.id, v_id, null, 'desmontagem_iniciada');
  end if;
  return v_id;
end;
$$;

-- Grava o checklist da etapa (fase aberto ou fechado). results = {"id do teste": "ok" | "fail" | ""}.
create or replace function public.save_repair_checklist(p_stage_id uuid, p_phase text, p_results jsonb) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
begin
  if p_phase not in ('aberto', 'fechado') or jsonb_typeof(p_results) <> 'object' then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  insert into public.repair_checklist_results (stage_id, phase, results)
  values (p_stage_id, p_phase, p_results)
  on conflict (stage_id, phase) do update set results = excluded.results, updated_by = (select auth.uid()), updated_at = now();
end;
$$;

-- Concluir o Estágio 1. Pode ter solicitações pendentes. Abre o Estágio 2 na mesma OS (mesmo técnico) e
-- devolve o id dele; todas as solicitações da OS continuam valendo.
create or replace function public.finish_disassembly(p_stage_id uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
  v_next uuid;
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
  values (v_stage.os_id, v_stage.serial, 'manutencao', v_stage.technician_id)
  on conflict (os_id, stage) do nothing
  returning id into v_next;
  if v_next is null then
    select id into v_next from public.repair_stages where os_id = v_stage.os_id and stage = 'manutencao';
  end if;

  -- Os pedidos feitos na desmontagem seguem valendo na manutenção.
  update public.stock_requests set stage_id = v_next
   where os_id = v_stage.os_id and status in ('pendente', 'em_separacao', 'sem_estoque') and stage_id = p_stage_id;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'desmontagem_concluida', jsonb_build_object('proxima_etapa', v_next));
  return v_next;
end;
$$;

-- O que ainda impede finalizar a manutenção da OS (lista vazia = pode finalizar).
create or replace function public.repair_finish_blockers(p_os_id uuid) returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[
    case when exists (select 1 from public.stock_requests
                       where os_id = p_os_id and status in ('pendente', 'em_separacao', 'sem_estoque'))
         then 'request_pending' end,
    case when exists (select 1 from public.stock_requests
                       where os_id = p_os_id and purpose = 'teste' and status = 'entregue' and test_destiny is null)
         then 'test_destiny_missing' end,
    case when exists (select 1 from public.stock_returns
                       where os_id = p_os_id and status = 'aguardando_recebimento')
         then 'return_unconfirmed' end
  ], null);
$$;

-- Finalizar a manutenção. Os testes reprovados vêm do que está gravado (não do que a tela manda).
-- p_required_open / p_required_closed: ids dos testes obrigatórios de cada fase (vêm do catálogo da tela).
-- p_resale: destino excepcional, só com justificativa.
-- Devolve o destino: quarentena (tudo aprovado), analise (algum reprovado) ou revenda.
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
  if exists (select 1 from public.repair_stages where os_id = v_stage.os_id and stage = 'desmontagem' and status <> 'concluida') then
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

  -- Fila futura de Análise: guarda também a revenda com teste reprovado, para a Análise saber o que falhou.
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

revoke all on function public.repair_finish_blockers(uuid) from public, anon;
revoke all on function public.start_disassembly(text) from public, anon;
revoke all on function public.save_repair_checklist(uuid, text, jsonb) from public, anon;
revoke all on function public.finish_disassembly(uuid) from public, anon;
revoke all on function public.finish_maintenance(uuid, text[], text[], boolean, text) from public, anon;
grant execute on function public.repair_finish_blockers(uuid) to authenticated;
grant execute on function public.start_disassembly(text) to authenticated;
grant execute on function public.save_repair_checklist(uuid, text, jsonb) to authenticated;
grant execute on function public.finish_disassembly(uuid) to authenticated;
grant execute on function public.finish_maintenance(uuid, text[], text[], boolean, text) to authenticated;
