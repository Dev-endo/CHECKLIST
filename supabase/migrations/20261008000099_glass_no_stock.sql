-- O vidro não se vincula mais ao estoque: abrir o serviço de vidro (do Reparo, do Checklist manutenção, da Análise ou
-- direto na aba Vidro) não pede mais Vidro e Aro ao estoque.
-- Rode depois de 20261008000098_glass_direct_finish.sql. Pode rodar de novo.
--
-- Todos os caminhos pedem o vidro por repair_request_glass_parts (migration 82); ela passa a não criar pedido nenhum.
-- Pedidos de vidro que já existem continuam como estão no estoque. A marca "vidro e outra manutenção" (needs_glass) segue
-- funcionando: o destino Vidro vem escolhido e a manutenção finaliza sem checklist.

create or replace function public.repair_request_glass_parts(p_stage public.repair_stages, p_origin text) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Sem pedido ao estoque (o vidro não depende mais dele). Mantida com a mesma assinatura para os chamadores.
  null;
end;
$$;

revoke all on function public.repair_request_glass_parts(public.repair_stages, text) from public, anon, authenticated;
