-- Aba Vidro, aparelho recebido direto: depois do vidro e do teste de display OK, o técnico de vidro só finaliza o vidro.
-- Não abre manutenção, checklist de montagem nem destinos (o técnico de vidro não monta).
-- Rode depois de 20261008000097_glass_send_display.sql. Pode rodar de novo.
--
-- finish_glass_direct(p_job_id): só para serviço de origem "vidro" já concluído; fecha o serviço. Display com falha segue
-- por glass_send_display (escolhe o técnico que faz).

create or replace function public.finish_glass_direct(p_job_id uuid) returns void
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
     set status = 'concluido', finished_by = (select auth.uid()), finished_at = now(), display_requested = false
   where id = j.id;
  perform public.repair_log(j.os_id, j.stage_id, null, 'vidro_finalizado_direto',
    jsonb_build_object('display_checklist', j.display_results));
end;
$$;

revoke all on function public.finish_glass_direct(uuid) from public, anon;
grant execute on function public.finish_glass_direct(uuid) to authenticated;
