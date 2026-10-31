-- MVP Reparo, banco 5/5: view que junta as solicitações novas (stock_requests) e as antigas (part_requests).
-- Rode depois de 20261008000047_repair_flow_functions.sql. Pode rodar de novo.
--
-- Só leitura. As telas novas gravam em stock_requests; o histórico antigo continua em part_requests, sem
-- alteração, e aparece aqui com source = 'legado' (quantidade 1; atendida = entregue; recusada = cancelada).
-- Nenhum dado antigo é copiado ou apagado.

create or replace view public.stock_requests_all with (security_invoker = true) as
select s.id, s.os_id, s.serial, s.part, s.purpose, s.qty, s.qty_delivered, s.status,
       s.requested_by, s.created_at, s.origin_stage, s.replaces_request_id, 'v2'::text as source
from public.stock_requests s
union all
select r.id, r.os_id, r.serial, r.part,
       case r.kind when 'teste' then 'teste' else 'definitiva' end,
       1,
       case when r.status = 'atendida' then 1 else 0 end,
       case r.status when 'atendida' then 'entregue' when 'recusada' then 'cancelada' else 'pendente' end,
       r.requested_by, r.created_at, null::text, null::uuid, 'legado'::text
from public.part_requests r
where r.kind in ('nova', 'teste');

grant select on public.stock_requests_all to authenticated;
