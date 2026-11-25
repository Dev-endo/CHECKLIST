-- Aba Vidro: "Enviar para técnico" aceita também o admin (inclusive o próprio admin que está no vidro).
-- Rode depois de 20261008000110_legacy_no_balloon_lock.sql. Pode rodar de novo.
-- Corpo da migration 100; só a checagem de quem recebe mudou (técnico ou admin, a mesma lista de lab_technicians).

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
        where p.id = p_technician
          and (p.role in ('tecnico', 'admin') or p.extra_roles && array['tecnico', 'admin']::public.user_role[])) then
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
