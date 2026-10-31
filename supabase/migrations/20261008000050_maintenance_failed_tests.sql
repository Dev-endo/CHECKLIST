-- Reparo, Estágio 2: os testes reprovados passam a vir só dos testes obrigatórios (não de qualquer chave gravada).
-- Rode depois de 20261008000049_technical_evaluation_stage.sql. Pode rodar de novo.
--
-- Antes, qualquer chave "fail" do checklist contava como reprovada, inclusive os tópicos de escolha
-- (ex.: original ou paralelo), que não são falha. Agora:
--   * reprovado = teste obrigatório (p_required_*) com resultado "fail", menos os tópicos de escolha (p_choice);
--   * os itens apontados dentro de um tópico reprovado ficam registrados à parte ({"fase", "item"}).

drop function if exists public.finish_maintenance(uuid, text[], text[], boolean, text);

create or replace function public.finish_maintenance(
  p_stage_id uuid, p_required_open text[], p_required_closed text[],
  p_resale boolean default false, p_resale_reason text default null, p_choice text[] default '{}'
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
      -- Itens apontados dentro de um tópico reprovado (só aparecem se houver tópico reprovado na fase).
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

  if p_resale then
    if char_length(v_reason) < 5 then
      raise exception 'resale_reason_required' using errcode = 'P0001';
    end if;
    v_outcome := 'revenda';
  elsif exists (select 1 from jsonb_array_elements(v_failed) x where x ? 'teste') then
    v_outcome := 'analise';
  else
    v_outcome := 'quarentena';
  end if;

  -- Sem teste reprovado, não há o que registrar (os itens só valem junto de um tópico reprovado).
  if not exists (select 1 from jsonb_array_elements(v_failed) x where x ? 'teste') then
    v_failed := '[]'::jsonb;
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

revoke all on function public.finish_maintenance(uuid, text[], text[], boolean, text, text[]) from public, anon;
grant execute on function public.finish_maintenance(uuid, text[], text[], boolean, text, text[]) to authenticated;
