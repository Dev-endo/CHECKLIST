-- MVP Reparo, banco 2/5: solicitações de peça, devoluções e movimentações do estoque.
-- Rode depois de 20261008000044_repair_stages_timer.sql. Pode rodar de novo.
--
-- Substitui, para as telas novas, o trio part_requests / part_allocations / part_loans (que continua no banco,
-- sem alteração, para o histórico e para as telas antigas; a view da migration 48 junta os dois).
-- Não há identificação por peça física: o rastreio é pelo ID da solicitação, técnico, OS e serial.

-- Solicitações ----------------------------------------------------------------------------------------------
create table if not exists public.stock_requests (
  id uuid primary key default gen_random_uuid(),
  os_id uuid not null references public.service_orders (id) on delete cascade,
  stage_id uuid references public.repair_stages (id) on delete set null,
  -- Etapa de onde veio o pedido (fica mesmo se a etapa for apagada).
  origin_stage text check (origin_stage in ('desmontagem', 'manutencao')),
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  part text not null check (char_length(btrim(part)) between 1 and 60),
  part_key text generated always as (lower(btrim(part))) stored,
  purpose text not null check (purpose in ('teste', 'definitiva')),
  qty integer not null check (qty between 1 and 99),
  qty_delivered integer not null default 0,
  status text not null default 'pendente'
    check (status in ('pendente', 'em_separacao', 'sem_estoque', 'entregue', 'cancelada')),
  requested_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  -- Substituição por defeito: a solicitação original.
  replaces_request_id uuid references public.stock_requests (id),
  -- Peça de teste entregue: utilização definitiva ou devolução.
  test_destiny text check (test_destiny in ('utilizacao_definitiva', 'devolucao')),
  test_destiny_at timestamptz,
  test_destiny_by uuid references public.profiles (id),
  cancel_reason text,
  cancelled_by uuid references public.profiles (id),
  cancelled_at timestamptz,
  -- Teste: só uma unidade por pedido (e por tipo, pelo índice abaixo).
  constraint stock_requests_test_qty_chk check (purpose <> 'teste' or qty = 1),
  constraint stock_requests_delivered_chk check (qty_delivered between 0 and qty),
  -- Entregue = tudo entregue; cancelada só sem nenhuma entrega.
  constraint stock_requests_status_chk check (
    (status = 'entregue') = (qty_delivered = qty) and (status <> 'cancelada' or qty_delivered = 0)
  ),
  constraint stock_requests_cancel_chk check (
    (status = 'cancelada') = (cancelled_at is not null and char_length(btrim(coalesce(cancel_reason, ''))) >= 3)
  ),
  constraint stock_requests_destiny_chk check (test_destiny is null or (purpose = 'teste' and status = 'entregue')),
  constraint stock_requests_replace_chk check (replaces_request_id is null or purpose = 'definitiva')
);

-- Teste do mesmo tipo, na mesma OS: só uma solicitação "viva" por vez. Viva = ainda aberta, ou entregue
-- sem destino definido. (Teste devolvido ou usado libera um novo pedido do mesmo tipo.)
create unique index if not exists stock_requests_test_open_idx
  on public.stock_requests (os_id, part_key)
  where purpose = 'teste'
    and (status in ('pendente', 'em_separacao', 'sem_estoque') or (status = 'entregue' and test_destiny is null));

create index if not exists stock_requests_os_idx on public.stock_requests (os_id, created_at);
create index if not exists stock_requests_serial_idx on public.stock_requests (serial_key, created_at);
create index if not exists stock_requests_open_idx
  on public.stock_requests (created_at) where status in ('pendente', 'em_separacao', 'sem_estoque');

-- Devoluções (teste devolvido ou peça definitiva defeituosa substituída) -------------------------------------
create table if not exists public.stock_returns (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.stock_requests (id) on delete cascade,
  os_id uuid not null references public.service_orders (id) on delete cascade,
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  part text not null,
  reason text not null check (reason in ('devolucao_teste', 'substituicao_defeito')),
  qty integer not null check (qty between 1 and 99),
  status text not null default 'aguardando_recebimento' check (status in ('aguardando_recebimento', 'recebida')),
  requested_by uuid not null default auth.uid() references public.profiles (id),
  requested_at timestamptz not null default now(),
  -- Só o estoque confirma o recebimento físico e classifica a peça.
  received_by uuid references public.profiles (id),
  received_at timestamptz,
  condition text check (condition in ('funcional', 'com_defeito', 'necessita_avaliacao')),
  constraint stock_returns_received_chk check (
    (status = 'recebida') = (received_by is not null and received_at is not null and condition is not null)
  )
);

create index if not exists stock_returns_os_idx on public.stock_returns (os_id);
create index if not exists stock_returns_waiting_idx on public.stock_returns (requested_at) where status = 'aguardando_recebimento';
-- Teste: uma devolução por solicitação.
create unique index if not exists stock_returns_test_once_idx
  on public.stock_returns (request_id) where reason = 'devolucao_teste';

-- Movimentações (log imutável) --------------------------------------------------------------------------------
-- stock_effect: -qty na entrega (baixa do estoque), +qty quando uma peça funcional volta ao disponível,
-- 0 em todo o resto. Utilização definitiva de teste NÃO baixa de novo (a baixa foi na entrega).
create table if not exists public.stock_movements (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.stock_requests (id) on delete cascade,
  return_id uuid references public.stock_returns (id) on delete cascade,
  os_id uuid not null references public.service_orders (id) on delete cascade,
  serial_key text not null,
  kind text not null check (kind in (
    'solicitacao', 'separacao', 'sem_estoque', 'entrega', 'cancelamento', 'destino_teste',
    'devolucao_solicitada', 'substituicao_solicitada', 'recebimento', 'retorno_disponivel', 'segregacao'
  )),
  qty integer not null default 0 check (qty >= 0),
  stock_effect integer not null default 0,
  detail jsonb not null default '{}'::jsonb,
  actor uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  -- Repetir o mesmo clique/lote não duplica a movimentação.
  idempotency_key text unique,
  constraint stock_movements_effect_chk check (
    (kind = 'entrega' and qty > 0 and stock_effect = -qty)
    or (kind = 'retorno_disponivel' and qty > 0 and stock_effect = qty)
    or (kind not in ('entrega', 'retorno_disponivel') and stock_effect = 0)
  )
);

create index if not exists stock_movements_request_idx on public.stock_movements (request_id, created_at);
create index if not exists stock_movements_os_idx on public.stock_movements (os_id, created_at);
-- Cada devolução volta ao disponível no máximo uma vez; cada teste tem um único destino.
create unique index if not exists stock_movements_return_once_idx
  on public.stock_movements (return_id) where kind in ('retorno_disponivel', 'segregacao');
create unique index if not exists stock_movements_receipt_once_idx
  on public.stock_movements (return_id) where kind = 'recebimento';
create unique index if not exists stock_movements_destiny_once_idx
  on public.stock_movements (request_id) where kind = 'destino_teste';

-- Nunca entrega mais do que foi pedido (mesmo com duas pessoas ao mesmo tempo).
create or replace function public.stock_movements_guard() returns trigger
language plpgsql
as $$
declare
  v_qty integer;
  v_done integer;
begin
  if new.kind = 'entrega' then
    select qty into v_qty from public.stock_requests where id = new.request_id for update;
    select coalesce(sum(qty), 0) into v_done from public.stock_movements where request_id = new.request_id and kind = 'entrega';
    if v_done + new.qty > v_qty then
      raise exception 'entrega acima do solicitado' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists stock_movements_check on public.stock_movements;
create trigger stock_movements_check before insert on public.stock_movements
  for each row execute function public.stock_movements_guard();

drop trigger if exists stock_movements_immutable on public.stock_movements;
create trigger stock_movements_immutable before update or delete on public.stock_movements
  for each row execute function public.forbid_change();

-- Permissões: leitura apenas; gravar só pelas funções (migration 46) -------------------------------------------
alter table public.stock_requests enable row level security;
alter table public.stock_returns enable row level security;
alter table public.stock_movements enable row level security;

grant select on public.stock_requests, public.stock_returns, public.stock_movements to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['stock_requests', 'stock_returns', 'stock_movements'] loop
    execute format('drop policy if exists "%1$s_select" on public.%1$s', t);
    execute format(
      'create policy "%1$s_select" on public.%1$s for select to authenticated
         using ((select public.has_any_role(array[''admin'', ''supervisor'', ''tecnico'', ''desmontador'', ''montador'', ''estoquista'']::public.user_role[])))',
      t);
  end loop;
end;
$$;

-- Peças recebidas que NÃO voltaram ao estoque disponível (defeito ou em avaliação), à parte do disponível.
create or replace view public.stock_segregated with (security_invoker = true) as
select r.id as return_id, r.request_id, r.os_id, r.serial, r.part, r.qty, r.condition, r.reason, r.received_at, r.received_by
from public.stock_returns r
where r.status = 'recebida' and r.condition <> 'funcional';

grant select on public.stock_segregated to authenticated;
