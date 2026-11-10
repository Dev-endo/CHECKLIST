-- Aba Vidro: o técnico de vidro só faz o vidro e testa a tela. Se o display falha (ou ele pede display antes do teste),
-- ele escolhe qual técnico de manutenção faz o display; se tudo está certo, devolve ao responsável pela desmontagem
-- (finish_glass). Nada disso mexe no estoque.
-- Rode depois de 20261008000096_glass_simple.sql. Pode rodar de novo.
--
-- glass_send_display(p_job_id, p_technician): fecha o serviço de vidro (display solicitado) e entrega o aparelho ao
-- técnico escolhido, que o encontra no Estágio 2 com o aviso "Direcionado por ...: display".

create or replace function public.glass_send_display(p_job_id uuid, p_technician uuid) returns uuid
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

  -- Mesmo caminho da entrega ao responsável (fecha o serviço e reabre a manutenção), marcando o display.
  if j.status <> 'vidro_concluido' then
    perform public.complete_glass(p_job_id);
  end if;
  v_stage := public.finish_glass(p_job_id, true);

  select display_results into j.display_results from public.repair_glass_jobs where id = p_job_id;
  v_note := case when j.display_results ->> 'tela-e-touch' = 'fail'
                 then 'Display reprovado no teste do vidro: trocar o display.'
                 else 'Display solicitado pelo técnico de vidro: trocar o display.' end;

  update public.repair_stages
     set technician_id = p_technician, handover_from = v_me, handover_note = v_note, handover_at = now()
   where id = v_stage;

  perform public.repair_log(j.os_id, v_stage, null, 'display_enviado_vidro',
    jsonb_build_object('para', p_technician, 'motivo', v_note, 'display_checklist', j.display_results));
  return v_stage;
end;
$$;

revoke all on function public.glass_send_display(uuid, uuid) from public, anon;
grant execute on function public.glass_send_display(uuid, uuid) to authenticated;
