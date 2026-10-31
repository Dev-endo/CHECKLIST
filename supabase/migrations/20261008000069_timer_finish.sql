-- Cronômetros: "Finalizar" para de contar exatamente quando a parte do trabalho acaba (sem finalizar a etapa).
-- Rode depois de 20261008000068_maintenance_count.sql. Pode rodar de novo.
--
-- Vale para todos: etapas (desmontagem, avaliação técnica, manutenção e montagem), análise, reparo em placa e vidro.
-- p_kind = 'fim' fecha a sessão aberta daquele cronômetro. Se precisar, dá para retomar depois (conta de novo).

create or replace function public.repair_timer_set(p_stage_id uuid, p_kind text, p_phase text default null) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
begin
  if p_kind not in ('produtivo', 'pausa', 'fim') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'etapa já concluída' using errcode = 'P0001';
  end if;
  if p_phase is not null and (v_stage.stage <> 'manutencao' or p_phase not in ('manutencao', 'montagem')) then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;

  if p_kind = 'fim' then
    -- Só fecha a sessão se ela for deste cronômetro (a espera de peça é do cronômetro da manutenção).
    if exists (
      select 1 from public.repair_timer_sessions o
      where o.stage_id = p_stage_id and o.ended_at is null
        and (p_phase is null
             or (o.kind = 'espera_peca' and p_phase = 'manutencao')
             or (o.kind <> 'espera_peca' and coalesce(o.phase, 'manutencao') = p_phase))
    ) then
      perform public.repair_timer_switch(p_stage_id, null);
    end if;
  else
    perform public.repair_timer_switch(p_stage_id, p_kind, p_phase);
  end if;
  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'cronometro_' || coalesce(p_phase || '_', '') || p_kind);
end;
$$;

revoke all on function public.repair_timer_set(uuid, text, text) from public, anon;
grant execute on function public.repair_timer_set(uuid, text, text) to authenticated;

-- Análise e reparo em placa.
create or replace function public.analysis_timer_set(p_id uuid, p_kind text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.repair_analysis_queue;
  v_me uuid := (select auth.uid());
  v_admin boolean := (select public.has_any_role(array['admin']::public.user_role[]));
  v_phase text;
  v_owner uuid;
begin
  if p_kind not in ('produtivo', 'pausa', 'fim') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found or not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if q.status = 'em_analise' then
    v_phase := 'analise';
    v_owner := q.started_by;
  elsif q.board_status = 'em_andamento' then
    v_phase := 'reparo_placa';
    v_owner := q.board_by;
  else
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if v_owner is distinct from v_me and not v_admin then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_kind = 'fim' then
    perform public.repair_analysis_timer_switch(p_id, null);
  else
    perform public.repair_analysis_timer_switch(p_id, p_kind, v_phase);
  end if;
  perform public.repair_log(q.os_id, q.stage_id, null, 'cronometro_' || v_phase || '_' || p_kind);
end;
$$;

revoke all on function public.analysis_timer_set(uuid, text) from public, anon;
grant execute on function public.analysis_timer_set(uuid, text) to authenticated;

-- Vidro.
create or replace function public.glass_timer_set(p_job_id uuid, p_kind text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.repair_glass_jobs;
begin
  if p_kind not in ('produtivo', 'pausa', 'fim') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into j from public.repair_glass_jobs where id = p_job_id for update;
  if not found
     or not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[]))
     or (j.started_by is distinct from (select auth.uid()) and not (select public.has_any_role(array['admin']::public.user_role[]))) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if j.status <> 'em_andamento' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  perform public.repair_glass_timer_switch(p_job_id, case when p_kind = 'fim' then null else p_kind end);
end;
$$;

revoke all on function public.glass_timer_set(uuid, text) from public, anon;
grant execute on function public.glass_timer_set(uuid, text) to authenticated;
