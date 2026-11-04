-- Peça de teste "Utilizar definitivamente" aparece para o estoquista.
-- Rode depois de 20261008000080_part_wait_ends_on_delivery.sql. Pode rodar de novo.
--
-- Antes, quando o técnico (ou o analista) decidia ficar com a peça de teste, isso só ficava no histórico da
-- solicitação: o estoque não sabia que a peça emprestada virou consumo. Agora ela entra na aba "Uso definitivo" do
-- quadro do estoque (e no aviso) até o estoquista clicar em "Ciente" (dar baixa).

alter table public.stock_requests
  add column if not exists test_kept_ack_at timestamptz,
  add column if not exists test_kept_ack_by uuid references public.profiles (id);

-- As decisões antigas (mais de 7 dias) contam como vistas, para a aba não começar cheia.
update public.stock_requests
   set test_kept_ack_at = test_destiny_at
 where test_destiny = 'utilizacao_definitiva' and test_kept_ack_at is null and test_destiny_at < now() - interval '7 days';

-- Nova movimentação: "Baixa da peça de teste" (o estoquista ficou ciente).
alter table public.stock_movements drop constraint if exists stock_movements_kind_check;
alter table public.stock_movements add constraint stock_movements_kind_check check (kind in (
  'solicitacao', 'separacao', 'sem_estoque', 'entrega', 'cancelamento', 'destino_teste',
  'devolucao_solicitada', 'substituicao_solicitada', 'recebimento', 'retorno_disponivel', 'segregacao',
  'baixa_definitiva'
));

create index if not exists stock_requests_kept_unacked_idx on public.stock_requests (test_destiny_at)
  where test_destiny = 'utilizacao_definitiva' and test_kept_ack_at is null;

-- Estoquista (ou admin) confirma que viu a peça de teste que ficou no aparelho.
create or replace function public.ack_test_kept(p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.stock_requests;
begin
  if not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into r from public.stock_requests where id = p_id for update;
  if not found or r.test_destiny is distinct from 'utilizacao_definitiva' then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  if r.test_kept_ack_at is not null then
    return;
  end if;
  update public.stock_requests set test_kept_ack_at = now(), test_kept_ack_by = (select auth.uid()) where id = p_id;
  perform public.stock_log(p_id, null, 'baixa_definitiva', r.qty_delivered, 0, '{}', null);
end;
$$;

revoke all on function public.ack_test_kept(uuid) from public, anon;
grant execute on function public.ack_test_kept(uuid) to authenticated;
