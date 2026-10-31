-- Aba Checklist manutenção: checklist dos aparelhos antigos (que não passaram pelo Estágio 1).
-- Rode depois de 20261008000072_dashboard_sent_to_analysis.sql. Pode rodar de novo.
--
-- O técnico bipa o serial (o aparelho precisa de OS), inicia o checklist e faz os testes com o aparelho aberto e
-- fechado (os mesmos do Estágio 2). Ao finalizar: Quarentena (tudo aprovado; com reprovação vai para a Análise
-- técnica), Análise técnica (mesmo sem reprovação) ou Vidro. Por usar a mesma manutenção, o aparelho entra na lista
-- da quarentena, na fila da análise, no vidro e nos números da aba Análise.

-- Manutenção aberta pela aba Checklist manutenção (não aparece na lista do Estágio 2).
alter table public.repair_stages add column if not exists legacy boolean not null default false;

create or replace function public.start_legacy_maintenance(p_serial text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_round integer;
  v_stage public.repair_stages;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  v_os := public.current_os(p_serial);
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = v_os.id;

  select * into v_stage from public.repair_stages where os_id = v_os.id and stage = 'manutencao' and round = v_round;
  if found then
    if v_stage.status = 'concluida' then
      -- Esta OS já teve a manutenção finalizada: uma nova checagem pede uma OS nova.
      raise exception 'already_done' using errcode = 'P0001';
    end if;
    return v_stage.id;
  end if;
  if exists (select 1 from public.repair_stages
              where os_id = v_os.id and round = v_round and stage in ('desmontagem', 'avaliacao') and status <> 'concluida') then
    -- O aparelho está no Estágio 1: segue por lá.
    raise exception 'disassembly_open' using errcode = 'P0001';
  end if;

  insert into public.repair_stages (os_id, serial, stage, technician_id, round, legacy)
  values (v_os.id, v_os.serial, 'manutencao', (select auth.uid()), v_round, true)
  returning * into v_stage;
  perform public.repair_log(v_os.id, v_stage.id, null, 'checklist_manutencao_iniciado');
  return v_stage.id;
end;
$$;

revoke all on function public.start_legacy_maintenance(text) from public, anon;
grant execute on function public.start_legacy_maintenance(text) to authenticated;

-- Finalizar a manutenção: além de vidro e revenda, Análise técnica escolhida mesmo sem teste reprovado.
drop function if exists public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean);

create or replace function public.finish_maintenance(
  p_stage_id uuid, p_required_open text[], p_required_closed text[],
  p_resale boolean default false, p_resale_reason text default null, p_choice text[] default '{}',
  p_glass boolean default false, p_analysis boolean default false
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
    insert into public.repair_analysis_queue (os_id, stage_id, serial, failed_tests)
    values (v_stage.os_id, p_stage_id, v_stage.serial, v_failed)
    on conflict (os_id) do update set failed_tests = excluded.failed_tests, stage_id = excluded.stage_id;
  end if;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'manutencao_finalizada',
    jsonb_build_object('destino', v_outcome, 'reprovados', v_failed, 'justificativa_revenda', nullif(v_reason, ''),
      'manutencoes', v_items));
  return v_outcome;
end;
$$;

revoke all on function public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean, boolean) from public, anon;
grant execute on function public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean, boolean) to authenticated;
