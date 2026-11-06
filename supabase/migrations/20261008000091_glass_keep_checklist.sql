-- Aba Vidro: o aparelho já desmontado (checklist aberto feito ou não) pode ficar com o técnico de vidro, que faz o
-- checklist aberto (se faltar), a montagem e o checklist fechado, e finaliza com todos os destinos (inclusive
-- Manutenção, escolhendo o técnico).
-- Rode depois de 20261008000090_glass_direct_flow.sql. Pode rodar de novo.
--
-- finish_glass_keep(p_job_id): igual a "Entregar ao responsável" (finish_glass), mas a manutenção reaberta fica com
-- o próprio técnico de vidro em vez de voltar para quem desmontou. As marcações já feitas ficam.

create or replace function public.finish_glass_keep(p_job_id uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage uuid;
  v_before uuid;
  v_me uuid := (select auth.uid());
begin
  if not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  v_stage := public.finish_glass(p_job_id, false);
  select technician_id into v_before from public.repair_stages where id = v_stage;

  update public.repair_stages
     set technician_id = v_me, handover_from = null, handover_note = null, handover_at = null
   where id = v_stage;

  perform public.repair_log((select os_id from public.repair_stages where id = v_stage), v_stage, null,
    'vidro_ficou_com_checklist', jsonb_build_object('de', v_before, 'para', v_me));
  return v_stage;
end;
$$;

revoke all on function public.finish_glass_keep(uuid) from public, anon;
grant execute on function public.finish_glass_keep(uuid) to authenticated;
