-- Análise técnica: guarda quem mandou o aparelho para a análise (para devolvê-lo à pessoa certa).
-- Rode depois de 20261008000058_board_repair.sql. Pode rodar de novo.
--
-- "Quem mandou" é quem concluiu a avaliação técnica com destino Análise técnica, ou quem finalizou a manutenção com
-- teste reprovado. Se o aparelho voltar à fila (nova reprovação), o remetente é atualizado.

alter table public.repair_analysis_queue add column if not exists sent_by uuid references public.profiles (id);
alter table public.repair_analysis_queue add column if not exists sent_at timestamptz;

-- Linhas que já existem: o melhor palpite é o técnico da etapa que gerou o envio.
update public.repair_analysis_queue q
   set sent_by = coalesce(q.sent_by, (select s.technician_id from public.repair_stages s where s.id = q.stage_id)),
       sent_at = coalesce(q.sent_at, q.created_at)
 where q.sent_by is null or q.sent_at is null;

create or replace function public.repair_queue_sent() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.sent_by := coalesce(new.sent_by, (select auth.uid()));
    new.sent_at := coalesce(new.sent_at, now());
  else
    -- Só dispara quando a linha é reenviada à fila (nova reprovação ou novo envio do Estágio 1).
    new.sent_by := coalesce((select auth.uid()), new.sent_by);
    new.sent_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists repair_queue_sent_insert on public.repair_analysis_queue;
create trigger repair_queue_sent_insert before insert on public.repair_analysis_queue
  for each row execute function public.repair_queue_sent();

drop trigger if exists repair_queue_sent_update on public.repair_analysis_queue;
create trigger repair_queue_sent_update before update of failed_tests, stage_id on public.repair_analysis_queue
  for each row execute function public.repair_queue_sent();
