-- "Espera de peça" para de contar quando o estoque libera a peça.
-- Rode depois de 20261008000079_lab_reads_names.sql. Pode rodar de novo.
--
-- Pedir peça põe o cronômetro em "Espera de peça" (Estágio 1, Estágio 2, Análise técnica e Reparo em placa). Antes,
-- ele seguia contando espera até o técnico clicar em Retomar, mesmo com a peça já entregue. Agora, quando não resta
-- pedido em aberto na OS (todos entregues ou cancelados), a espera termina sozinha e o cronômetro fica pausado: o
-- técnico clica em Retomar quando voltar ao aparelho. Mesmo critério de "Aguardando peças" (migration 52).

create or replace function public.repair_end_part_wait() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.repair_timer_sessions;
begin
  if new.status in ('entregue', 'cancelada') and old.status is distinct from new.status
     and not exists (select 1 from public.stock_requests
                      where os_id = new.os_id and status in ('pendente', 'em_separacao', 'sem_estoque')) then
    -- Etapas do Reparo (desmontagem, avaliação técnica, manutenção) da OS.
    for s in
      select ts.* from public.repair_timer_sessions ts
        join public.repair_stages st on st.id = ts.stage_id
       where st.os_id = new.os_id and ts.ended_at is null and ts.kind = 'espera_peca'
    loop
      perform public.repair_timer_switch(s.stage_id, 'pausa', s.phase);
      perform public.repair_log(new.os_id, s.stage_id, new.id, 'espera_peca_encerrada', '{}');
    end loop;
    -- Análise técnica e reparo em placa da OS.
    for s in
      select ts.* from public.repair_timer_sessions ts
        join public.repair_analysis_queue q on q.id = ts.analysis_id
       where q.os_id = new.os_id and ts.ended_at is null and ts.kind = 'espera_peca'
    loop
      perform public.repair_analysis_timer_switch(s.analysis_id, 'pausa', s.phase);
      perform public.repair_log(new.os_id, null, new.id, 'espera_peca_encerrada', jsonb_build_object('analise', s.analysis_id));
    end loop;
  end if;
  return null;
end;
$$;

revoke all on function public.repair_end_part_wait() from public, anon, authenticated;

drop trigger if exists stock_requests_end_part_wait on public.stock_requests;
create trigger stock_requests_end_part_wait after update of status on public.stock_requests
  for each row execute function public.repair_end_part_wait();
