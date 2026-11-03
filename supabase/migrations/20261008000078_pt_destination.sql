-- Destino PT (perda total), Vidro sem checklist e Revenda com motivo, no Reparo (Estágio 2) e no Checklist manutenção.
-- Rode depois de 20261008000077_analysis_send_note.sql. Pode rodar de novo.
--
-- * PT: o técnico escreve o motivo; o aparelho fica com "aprovação pendente" até um administrador ou supervisor
--   decidir (aba Aprovação PT). Aprovado, fecha como PT. Reprovado (com comentário), a manutenção volta para o técnico.
-- * Vidro: não exige o checklist (o aparelho volta para o técnico depois do vidro, como antes).
-- * Revenda: continua exigindo o motivo (agora também no Checklist manutenção).

alter table public.repair_stages drop constraint if exists repair_stages_outcome_check;
alter table public.repair_stages
  add constraint repair_stages_outcome_check check (outcome in ('quarentena', 'analise', 'revenda', 'vidro', 'pt'));

create table if not exists public.repair_pt_requests (
  id uuid primary key default gen_random_uuid(),
  os_id uuid not null references public.service_orders (id) on delete cascade,
  stage_id uuid not null references public.repair_stages (id) on delete cascade,
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  reason text not null,
  requested_by uuid references public.profiles (id),
  requested_at timestamptz not null default now(),
  status text not null default 'pendente' check (status in ('pendente', 'aprovado', 'reprovado')),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  decision_note text
);
create unique index if not exists repair_pt_pending_idx on public.repair_pt_requests (stage_id) where status = 'pendente';
create index if not exists repair_pt_status_idx on public.repair_pt_requests (status, requested_at);

alter table public.repair_pt_requests enable row level security;
grant select on public.repair_pt_requests to authenticated;
drop policy if exists "repair_pt_requests_select" on public.repair_pt_requests;
create policy "repair_pt_requests_select" on public.repair_pt_requests for select to authenticated
  using ((select public.has_any_role(array['admin', 'supervisor', 'tecnico', 'analista']::public.user_role[])));

-- Fim da manutenção (corpo da migration 77) com PT e Vidro sem checklist.
drop function if exists public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean, boolean, text);

create or replace function public.finish_maintenance(
  p_stage_id uuid, p_required_open text[], p_required_closed text[],
  p_resale boolean default false, p_resale_reason text default null, p_choice text[] default '{}',
  p_glass boolean default false, p_analysis boolean default false, p_analysis_note text default null,
  p_pt boolean default false
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
  if (p_resale::int + p_glass::int + p_analysis::int + p_pt::int) > 1 then
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

  -- Vidro e PT não exigem o checklist: o aparelho vai para o vidro (e volta para o técnico) ou espera a aprovação do PT.
  v_skip_tests := p_glass or p_pt;

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

  if p_pt then
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
         resale_reason = case when v_outcome in ('revenda', 'pt') then v_reason end,
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
  elsif v_has_failure or v_outcome = 'analise' then
    -- Análise (reprovado ou escolhida) ou revenda com reprovação: a fila guarda o que falhou.
    insert into public.repair_analysis_queue (os_id, stage_id, serial, failed_tests, send_note)
    values (v_stage.os_id, p_stage_id, v_stage.serial, v_failed, case when v_outcome = 'analise' then left(v_note, 1000) end)
    on conflict (os_id) do update
      set failed_tests = excluded.failed_tests, stage_id = excluded.stage_id, send_note = excluded.send_note;
  end if;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'manutencao_finalizada',
    jsonb_build_object('destino', v_outcome, 'reprovados', v_failed, 'justificativa_revenda', case when v_outcome = 'revenda' then nullif(v_reason, '') end,
      'motivo_pt', case when v_outcome = 'pt' then nullif(v_reason, '') end,
      'manutencoes', v_items, 'motivo_analise', case when v_outcome = 'analise' then nullif(v_note, '') end));
  return v_outcome;
end;
$$;

revoke all on function public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean, boolean, text, boolean) from public, anon;
grant execute on function public.finish_maintenance(uuid, text[], text[], boolean, text, text[], boolean, boolean, text, boolean) to authenticated;

-- Decisão do PT: administrador ou supervisor. Reprovar exige comentário e devolve a manutenção ao técnico.
create or replace function public.decide_pt(p_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.repair_pt_requests;
  v_note text := btrim(coalesce(p_note, ''));
begin
  if not (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into r from public.repair_pt_requests where id = p_id for update;
  if not found or r.status <> 'pendente' then
    raise exception 'pt_closed' using errcode = 'P0001';
  end if;
  if not coalesce(p_approve, false) and char_length(v_note) < 5 then
    raise exception 'pt_note_required' using errcode = 'P0001';
  end if;

  update public.repair_pt_requests
     set status = case when p_approve then 'aprovado' else 'reprovado' end,
         decided_by = (select auth.uid()), decided_at = now(), decision_note = nullif(left(v_note, 1000), '')
   where id = r.id;

  if not p_approve then
    update public.repair_stages
       set status = 'em_andamento', finished_at = null, outcome = null, resale_reason = null, failed_tests = '[]'::jsonb
     where id = r.stage_id and status = 'concluida' and outcome = 'pt';
  end if;

  perform public.repair_log(r.os_id, r.stage_id, null, case when p_approve then 'pt_aprovado' else 'pt_reprovado' end,
    jsonb_build_object('motivo', r.reason, 'comentario', nullif(v_note, '')));
end;
$$;

revoke all on function public.decide_pt(uuid, boolean, text) from public, anon;
grant execute on function public.decide_pt(uuid, boolean, text) to authenticated;

-- Checklist manutenção: com PT aguardando aprovação, bipar o serial não abre outro checklist (corpo da migration 74).
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

  if exists (select 1 from public.repair_stages
              where os_id = v_os.id and round = v_round and stage in ('desmontagem', 'avaliacao') and status <> 'concluida') then
    raise exception 'disassembly_open' using errcode = 'P0001';
  end if;
  -- PT aguardando aprovação: não abre outro checklist enquanto ninguém decidir.
  if exists (select 1 from public.repair_pt_requests where os_id = v_os.id and status = 'pendente') then
    raise exception 'pt_pending' using errcode = 'P0001';
  end if;
  -- No Vidro: o checklist volta sozinho para o técnico quando o vidro terminar (não abre um novo).
  if exists (select 1 from public.repair_glass_jobs where os_id = v_os.id and status <> 'concluido') then
    raise exception 'in_glass' using errcode = 'P0001';
  end if;

  select * into v_stage from public.repair_stages where os_id = v_os.id and stage = 'manutencao' and round = v_round;
  if found then
    if v_stage.status <> 'concluida' then
      if not v_stage.legacy then
        -- Manutenção do Estágio 2 em andamento: o aparelho está no Reparo.
        raise exception 'in_repair' using errcode = 'P0001';
      end if;
      return v_stage.id;
    end if;
    -- Já foi checado nesta OS: um checklist novo, na rodada seguinte (o anterior fica no histórico).
    v_round := v_round + 1;
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
