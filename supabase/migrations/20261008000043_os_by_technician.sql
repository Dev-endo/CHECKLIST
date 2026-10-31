-- Aba Reparo: o técnico também registra a OS do ativo (estágio 1: OS, desmontagem, análise básica, pedido de peça).
-- Rode depois de 20261008000042_swapped_parts_stock.sql. Pode rodar de novo.

drop policy if exists "service_orders_insert" on public.service_orders;
create policy "service_orders_insert" on public.service_orders
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.has_any_role(array['admin', 'desmontador', 'tecnico']::public.user_role[]))
  );
