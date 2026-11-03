-- Enviar para a Análise técnica exige justificativa: um campo de observação com o motivo.
-- Rode depois de 20261008000076_replacement_reason.sql. Pode rodar de novo.
--
-- Vale nos dois caminhos para a análise: o fim da manutenção (Estágio 2, Checklist manutenção e Checklist e montagem),
-- quando o destino é a Análise técnica (escolhida ou por teste reprovado), e o fim do Estágio 1 com destino Análise.
-- O motivo fica na fila (aparece para o analista) e no histórico.

alter table public.repair_analysis_queue add column if not exists send_note text;

-- Fim da manutenção (corpo da migration 73) com o motivo da análise.
drop function if exists public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean, boolean);

create or replace function public.finish_maintenance(
  p_stage_id uuid, p_required_open text[], p_required_closed text[],
  p_resale boolean default false, p_resale_reason text default null, p_choice text[] default '{}',
  p_glass boolean default false, p_analysis boolean default false, p_analysis_note text default null
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
begin
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'manutencao' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  if (p_resale::int + p_glass::int + p_analysis::int) > 1 then
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

  v_has_failure := exists (select 1 from jsonb_array_elements(v_failed) x where x ? 'teste');
  if not v_has_failure then
    v_failed := '[]'::jsonb;
  end if;

  if p_resale then
    if char_length(v_reason) < 5 then
      raise exception 'resale_reason_required' using errcode = 'P0001';
    end if;
    v_outcome := 'revenda';
  elsif p_glass then
    v_outcome := 'vidro';
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
         resale_reason = case when v_outcome = 'revenda' then v_reason end,
         maintenance_items = v_items,
         maintenance_count = (select coalesce(sum(coalesce((i ->> 'qtd')::integer, 1)), 0) from jsonb_array_elements(v_items) i)
   where id = p_stage_id;

  if v_outcome = 'vidro' then
    -- O aparelho volta para este técnico depois do vidro (a aba Vidro reabre a manutenção).
    perform public.repair_open_glass(v_stage, 'manutencao', v_stage.technician_id);
  elsif v_has_failure or v_outcome = 'analise' then
    -- Análise (reprovado ou escolhida) ou revenda com reprovação: a fila guarda o que falhou.
    insert into public.repair_analysis_queue (os_id, stage_id, serial, failed_tests, send_note)
    values (v_stage.os_id, p_stage_id, v_stage.serial, v_failed, case when v_outcome = 'analise' then left(v_note, 1000) end)
    on conflict (os_id) do update
      set failed_tests = excluded.failed_tests, stage_id = excluded.stage_id, send_note = excluded.send_note;
  end if;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'manutencao_finalizada',
    jsonb_build_object('destino', v_outcome, 'reprovados', v_failed, 'justificativa_revenda', nullif(v_reason, ''),
      'manutencoes', v_items, 'motivo_analise', case when v_outcome = 'analise' then nullif(v_note, '') end));
  return v_outcome;
end;
$$;

revoke all on function public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean, boolean, text) from public, anon;
grant execute on function public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean, boolean, text) to authenticated;

-- Fim do Estágio 1 (corpo da migration 55) com o motivo da análise.
drop function if exists public.finish_evaluation(uuid, text);

create or replace function public.finish_evaluation(p_stage_id uuid, p_destination text default 'manutencao', p_note text default null) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
  v_next uuid;
  v_note text := btrim(coalesce(p_note, ''));
begin
  if p_destination not in ('manutencao', 'vidro', 'analise', 'aguardando_pecas') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'avaliacao' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  -- Indo para a Análise técnica: o técnico explica o motivo.
  if p_destination = 'analise' and char_length(v_note) < 5 then
    raise exception 'analysis_note_required' using errcode = 'P0001';
  end if;
  if p_destination = 'aguardando_pecas'
     and not exists (select 1 from public.stock_requests
                      where os_id = v_stage.os_id and status in ('pendente', 'em_separacao', 'sem_estoque')) then
    raise exception 'nothing_to_wait' using errcode = 'P0001';
  end if;

  perform public.repair_timer_switch(p_stage_id, null);
  update public.repair_stages
     set status = 'concluida', finished_at = now(), destination = p_destination
   where id = p_stage_id;

  if p_destination in ('manutencao', 'aguardando_pecas') then
    insert into public.repair_stages (os_id, serial, stage, technician_id, status, round)
    values (v_stage.os_id, v_stage.serial, 'manutencao', v_stage.technician_id,
            case when p_destination = 'aguardando_pecas' then 'aguardando_pecas' else 'em_andamento' end, v_stage.round)
    on conflict (os_id, stage, round) do nothing
    returning id into v_next;
    if v_next is null then
      select id into v_next from public.repair_stages where os_id = v_stage.os_id and stage = 'manutencao' and round = v_stage.round;
    end if;
    update public.stock_requests set stage_id = v_next
     where os_id = v_stage.os_id and status in ('pendente', 'em_separacao', 'sem_estoque') and stage_id = p_stage_id;

  elsif p_destination = 'vidro' then
    perform public.repair_open_glass(v_stage, 'avaliacao', v_stage.technician_id);

  else
    insert into public.repair_analysis_queue (os_id, stage_id, serial, source, send_note)
    values (v_stage.os_id, p_stage_id, v_stage.serial, 'estagio1', left(v_note, 1000))
    on conflict (os_id) do update
      set status = 'aguardando', stage_id = excluded.stage_id, source = 'estagio1', send_note = excluded.send_note;
  end if;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'avaliacao_concluida',
    jsonb_build_object('destino', p_destination, 'proxima_etapa', v_next,
      'motivo_analise', case when p_destination = 'analise' then nullif(v_note, '') end));
  return v_next;
end;
$$;

revoke all on function public.finish_evaluation(uuid, text, text) from public, anon;
grant execute on function public.finish_evaluation(uuid, text, text) to authenticated;
