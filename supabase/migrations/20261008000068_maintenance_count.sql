-- Estágio 2 / Checklist e montagem: contagem de manutenções de quem finaliza.
-- Rode depois de 20261008000067_analyst_does_swap.sql. Pode rodar de novo.
--
-- Contam para quem finaliza a manutenção (técnico ou analista):
--   * 1 pelo reparo em placa que ELE fez nesta OS (mesma rodada);
--   * 1 por peça usada de vez na rodada: definitiva entregue (menos as devolvidas por defeito, cuja substituta conta
--     no lugar) e peça de teste marcada como "utilização definitiva".
-- A lista e o total ficam gravados na etapa ao finalizar (maintenance_items / maintenance_count).

alter table public.repair_stages add column if not exists maintenance_items jsonb not null default '[]'::jsonb;
alter table public.repair_stages add column if not exists maintenance_count integer not null default 0;

create or replace function public.repair_maintenance_items(p_stage_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with st as (
    select * from public.repair_stages where id = p_stage_id
  ),
  same_round as (
    select r.id from public.repair_stages r, st where r.os_id = st.os_id and r.round = st.round
  ),
  board as (
    select 1 as ord, 'Placa' as nome,
           jsonb_build_object('tipo', 'placa', 'descricao', q.board_note) as item
    from public.repair_analysis_queue q, st
    where q.os_id = st.os_id
      and q.board_status = 'concluido'
      and q.board_by = st.technician_id
      and q.stage_id in (select id from same_round)
  ),
  parts as (
    select 2 as ord, r.part as nome,
           jsonb_build_object('tipo', 'peca', 'peca', r.part,
             'qtd', case when r.purpose = 'teste' then 1
                         else r.qty_delivered - coalesce((select sum(t.qty) from public.stock_returns t
                                                           where t.request_id = r.id and t.reason = 'substituicao_defeito'), 0) end,
             'finalidade', r.purpose) as item
    from public.stock_requests r
    where r.stage_id in (select id from same_round)
      and (
        (r.purpose = 'definitiva'
          and r.qty_delivered - coalesce((select sum(t.qty) from public.stock_returns t
                                          where t.request_id = r.id and t.reason = 'substituicao_defeito'), 0) > 0)
        or (r.purpose = 'teste' and r.test_destiny = 'utilizacao_definitiva')
      )
  )
  select coalesce(jsonb_agg(x.item order by x.ord, x.nome), '[]'::jsonb)
  from (select * from board union all select * from parts) x
  where (select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]));
$$;

revoke all on function public.repair_maintenance_items(uuid) from public, anon;
grant execute on function public.repair_maintenance_items(uuid) to authenticated;

-- Finalizar a manutenção (corpo da migration 63 + contagem de manutenções).
create or replace function public.finish_maintenance(
  p_stage_id uuid, p_required_open text[], p_required_closed text[],
  p_resale boolean default false, p_resale_reason text default null, p_choice text[] default '{}',
  p_glass boolean default false
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
  if p_resale and p_glass then
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
  elsif v_has_failure then
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
  elsif v_has_failure then
    -- Análise (reprovado) ou revenda com reprovação: a fila guarda o que falhou.
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

revoke all on function public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean) from public, anon;
grant execute on function public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean) to authenticated;
