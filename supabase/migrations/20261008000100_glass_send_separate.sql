-- Aba Vidro: enviar o aparelho para outro técnico e pedir a troca de display são coisas separadas.
-- Rode depois de 20261008000099_glass_no_stock.sql. Pode rodar de novo.
--
--   * "Troca de display solicitada" (p_display) é só uma marca: não pede nada ao estoque nem escolhe técnico. Quem recebe o
--     aparelho (o responsável pela desmontagem ou o técnico escolhido) vê o aviso na manutenção.
--   * Enviar para outro técnico (glass_send_display, agora com p_display) vale com ou sem troca de display.
--   * finish_glass_direct também registra a troca de display.

-- Entregar ao responsável (corpo da migration 96) + aviso da troca de display na manutenção.
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

  -- Troca de display solicitada: só um aviso para quem recebe o aparelho (nada vai para o estoque).
  if coalesce(p_display, false) then
    update public.repair_stages
       set handover_from = (select auth.uid()),
           handover_note = case when j.display_results ->> 'tela-e-touch' = 'fail'
                                then 'Troca de display solicitada: display reprovado no teste do vidro.'
                                else 'Troca de display solicitada pelo técnico de vidro.' end,
           handover_at = now()
     where id = v_stage;
  end if;

  perform public.repair_log(j.os_id, v_stage, null, 'vidro_entregue',
    jsonb_build_object('responsavel', j.responsible_id, 'display_solicitado', coalesce(p_display, false),
                       'display_checklist', j.display_results));
  return v_stage;
end;
$$;

revoke all on function public.finish_glass(uuid, boolean) from public, anon;
grant execute on function public.finish_glass(uuid, boolean) to authenticated;

-- Enviar o aparelho para outro técnico, com ou sem troca de display.
drop function if exists public.glass_send_display(uuid, uuid);

create or replace function public.glass_send_display(p_job_id uuid, p_technician uuid, p_display boolean default false) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.repair_glass_jobs;
  v_stage uuid;
  v_me uuid := (select auth.uid());
  v_note text;
begin
  if not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_technician is null or not exists (
       select 1 from public.profiles p
        where p.id = p_technician and (p.role = 'tecnico' or 'tecnico'::public.user_role = any (p.extra_roles))) then
    raise exception 'handover_target_invalid' using errcode = 'P0001';
  end if;
  select * into j from public.repair_glass_jobs where id = p_job_id;
  if not found or j.status not in ('aguardando', 'em_andamento', 'vidro_concluido') then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;

  if j.status <> 'vidro_concluido' then
    perform public.complete_glass(p_job_id);
  end if;
  v_stage := public.finish_glass(p_job_id, coalesce(p_display, false));

  select display_results into j.display_results from public.repair_glass_jobs where id = p_job_id;
  v_note := case
    when coalesce(p_display, false) and j.display_results ->> 'tela-e-touch' = 'fail'
      then 'Enviado pelo técnico de vidro. Troca de display solicitada: display reprovado no teste do vidro.'
    when coalesce(p_display, false)
      then 'Enviado pelo técnico de vidro. Troca de display solicitada.'
    else 'Enviado pelo técnico de vidro depois do vidro.'
  end;

  update public.repair_stages
     set technician_id = p_technician, handover_from = v_me, handover_note = v_note, handover_at = now()
   where id = v_stage;

  perform public.repair_log(j.os_id, v_stage, null, 'vidro_enviado_tecnico',
    jsonb_build_object('para', p_technician, 'display_solicitado', coalesce(p_display, false), 'motivo', v_note,
                       'display_checklist', j.display_results));
  return v_stage;
end;
$$;

revoke all on function public.glass_send_display(uuid, uuid, boolean) from public, anon;
grant execute on function public.glass_send_display(uuid, uuid, boolean) to authenticated;

-- Vidro recebido direto: finaliza registrando se a troca de display foi solicitada.
drop function if exists public.finish_glass_direct(uuid);

create or replace function public.finish_glass_direct(p_job_id uuid, p_display boolean default false) returns void
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
  if not found or j.status <> 'vidro_concluido' or j.origin <> 'vidro' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  update public.repair_glass_jobs
     set status = 'concluido', finished_by = (select auth.uid()), finished_at = now(), display_requested = coalesce(p_display, false)
   where id = j.id;
  perform public.repair_log(j.os_id, j.stage_id, null, 'vidro_finalizado_direto',
    jsonb_build_object('display_solicitado', coalesce(p_display, false), 'display_checklist', j.display_results));
end;
$$;

revoke all on function public.finish_glass_direct(uuid, boolean) from public, anon;
grant execute on function public.finish_glass_direct(uuid, boolean) to authenticated;
