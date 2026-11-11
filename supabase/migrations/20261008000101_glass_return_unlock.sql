-- Aparelho que volta do vidro: a marca "vidro e outra manutenção" (needs_glass) é zerada, senão o checklist fica
-- travado e só deixa escolher o destino Vidro de novo. Rode depois de 20261008000100_glass_send_separate.sql.

-- finish_glass: igual à migration 100, mais a liberação do checklist.
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
       set status = 'em_andamento', finished_at = null, outcome = null, resale_reason = null, failed_tests = '[]'::jsonb,
           needs_glass = false
     where id = v_stage and status = 'concluida';
    update public.repair_stages set needs_glass = false where id = v_stage;
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
