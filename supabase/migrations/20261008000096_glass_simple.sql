-- Aba Vidro sem travamento: concluir o vidro não espera mais o estoque nem o cronômetro, o checklist de display é
-- o único teste e "Solicitar display" / "Entregar ao responsável" não mexem mais no estoque.
-- Rode depois de 20261008000095_declared_maintenance.sql. Pode rodar de novo.
--
--   complete_glass:  conclui direto (serviço aguardando ou em andamento), sem exigir o Vidro/Aro entregue e sem tempo;
--   save_glass_display: grava o checklist de display (Tela e touch) do serviço de vidro;
--   finish_glass:    entrega ao responsável; "display" só registra que o display foi pedido (não cria pedido no estoque).

alter table public.repair_glass_jobs add column if not exists display_results jsonb not null default '{}'::jsonb;

-- Concluir vidro: qualquer técnico de vidro (ou o admin), a qualquer momento antes da entrega.
create or replace function public.complete_glass(p_job_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.repair_glass_jobs;
begin
  if not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into j from public.repair_glass_jobs where id = p_job_id for update;
  if not found or j.status not in ('aguardando', 'em_andamento') then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  -- Se havia cronômetro aberto (serviço começado antes desta mudança), fecha.
  perform public.repair_glass_timer_switch(p_job_id, null);
  update public.repair_glass_jobs
     set status = 'vidro_concluido',
         started_by = coalesce(started_by, (select auth.uid())),
         started_at = coalesce(started_at, now()),
         glass_done_by = (select auth.uid()), glass_done_at = now()
   where id = p_job_id;
  perform public.repair_log(j.os_id, j.stage_id, null, 'vidro_concluido');
end;
$$;

revoke all on function public.complete_glass(uuid) from public, anon;
grant execute on function public.complete_glass(uuid) to authenticated;

-- Checklist de display do serviço de vidro (results = {"id do teste": "ok" | "fail" | ""}).
create or replace function public.save_glass_display(p_job_id uuid, p_results jsonb) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.repair_glass_jobs;
begin
  if not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_results is null or jsonb_typeof(p_results) <> 'object' then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into j from public.repair_glass_jobs where id = p_job_id for update;
  if not found or j.status = 'concluido' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  update public.repair_glass_jobs set display_results = p_results where id = p_job_id;
end;
$$;

revoke all on function public.save_glass_display(uuid, jsonb) from public, anon;
grant execute on function public.save_glass_display(uuid, jsonb) to authenticated;

-- Entregar ao responsável (corpo da migration 64): sem pedido de display no estoque.
create or replace function public.finish_glass(p_job_id uuid, p_display boolean default false) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.repair_glass_jobs;
  v_stage uuid;
  v_round integer;
begin
  if not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into j from public.repair_glass_jobs where id = p_job_id for update;
  if not found or j.status <> 'vidro_concluido' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;

  update public.repair_glass_jobs
     set status = 'concluido', finished_by = (select auth.uid()), finished_at = now(), display_requested = coalesce(p_display, false)
   where id = j.id;

  -- A rodada do serviço de vidro é a da etapa que o pediu (se a etapa sumiu, a mais recente da OS).
  select round into v_round from public.repair_stages where id = j.stage_id;
  if v_round is null then
    select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = j.os_id;
  end if;

  select id into v_stage from public.repair_stages where os_id = j.os_id and stage = 'manutencao' and round = v_round;
  if v_stage is null then
    insert into public.repair_stages (os_id, serial, stage, technician_id, round)
    values (j.os_id, j.serial, 'manutencao', j.responsible_id, v_round)
    returning id into v_stage;
  else
    update public.repair_stages
       set status = 'em_andamento', finished_at = null, outcome = null, resale_reason = null, failed_tests = '[]'::jsonb
     where id = v_stage and status = 'concluida';
  end if;

  perform public.repair_log(j.os_id, v_stage, null, 'vidro_entregue',
    jsonb_build_object('responsavel', j.responsible_id, 'display_solicitado', coalesce(p_display, false),
                       'display_checklist', j.display_results));
  return v_stage;
end;
$$;

revoke all on function public.finish_glass(uuid, boolean) from public, anon;
grant execute on function public.finish_glass(uuid, boolean) to authenticated;
