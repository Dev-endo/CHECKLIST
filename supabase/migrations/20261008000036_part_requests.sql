-- Estoque, etapa 2: pedidos de peça (nova, teste, troca) e o fechamento das peças alocadas pelo técnico.
-- Rode depois de 20261008000035_stock_allocation.sql. Pode rodar de novo.
--
-- Técnico (e desmontador, para peça de teste) pedem; o estoquista decide.
--   nova  : o estoquista atende (aloca a peça na OS atual) ou recusa.
--   troca : o técnico pede a troca de uma peça alocada; o estoquista decide se a peça estava ruim ou se foi
--           erro técnico. Nos dois casos a peça sai como "trocada" e uma nova é alocada na mesma OS.
--   teste : o aviso já chega ao estoquista; a liberação da peça de teste entra na etapa 3.
-- Devolver (não precisou da peça) e concluir (a peça foi aplicada) o técnico faz direto.

alter table public.part_allocations
  add column if not exists swap_reason text check (swap_reason in ('peca_ruim', 'erro_tecnico'));

create table if not exists public.part_requests (
  id uuid primary key default gen_random_uuid(),
  os_id uuid not null references public.service_orders (id) on delete cascade,
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  part text not null check (char_length(btrim(part)) between 1 and 60),
  kind text not null check (kind in ('nova', 'teste', 'troca')),
  -- Só na troca: a peça alocada que o técnico quer trocar.
  allocation_id uuid references public.part_allocations (id) on delete cascade,
  status text not null default 'pendente' check (status in ('pendente', 'atendida', 'recusada')),
  resolution text check (resolution in ('peca_ruim', 'erro_tecnico')),
  requested_by uuid not null default auth.uid() references public.profiles (id),
  resolved_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Não repete o mesmo pedido enquanto o anterior está pendente.
create unique index if not exists part_requests_open_idx
  on public.part_requests (os_id, part, kind) where status = 'pendente';
create index if not exists part_requests_serial_idx on public.part_requests (serial_key, created_at);

alter table public.part_requests enable row level security;
grant select on public.part_requests to authenticated;

drop policy if exists "part_requests_select" on public.part_requests;
create policy "part_requests_select" on public.part_requests
  for select to authenticated
  using ((select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista']::public.user_role[])));

-- Pede uma peça para o aparelho, na OS mais recente do serial.
-- Erros: no_os (aparelho sem OS do estoque), 23505 (pedido igual já pendente).
create or replace function public.request_part(
  p_serial text, p_part text, p_kind text, p_allocation_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(p_serial));
  v_os public.service_orders;
  v_part text := btrim(coalesce(p_part, ''));
  v_id uuid;
begin
  if not (select public.has_any_role(array['admin', 'tecnico', 'desmontador']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_kind not in ('nova', 'teste', 'troca') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;

  select * into v_os from public.service_orders where serial_key = v_key order by created_at desc limit 1;
  if not found then
    raise exception 'no_os' using errcode = 'P0001';
  end if;

  if p_kind = 'troca' then
    select a.part into v_part from public.part_allocations a
    where a.id = p_allocation_id and a.os_id = v_os.id and a.status = 'alocada';
    if not found then
      raise exception 'dados incompletos' using errcode = '22023';
    end if;
  elsif v_part = '' then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;

  insert into public.part_requests (os_id, serial, part, kind, allocation_id, requested_by)
  values (v_os.id, v_os.serial, v_part, p_kind, p_allocation_id, (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.request_part(text, text, text, uuid) from public, anon;
grant execute on function public.request_part(text, text, text, uuid) to authenticated;

-- O técnico fecha a peça alocada: concluir (foi aplicada) ou devolver (não precisou dela).
create or replace function public.complete_allocation(p_id uuid, p_action text) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_action not in ('concluir', 'devolver') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  update public.part_allocations
     set status = case p_action when 'concluir' then 'concluida' else 'devolvida' end
   where id = p_id and status = 'alocada';
  if not found then
    raise exception 'peça já fechada' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.complete_allocation(uuid, text) from public, anon;
grant execute on function public.complete_allocation(uuid, text) to authenticated;

-- O estoquista decide um pedido. p_decision: recusar (qualquer pedido), atender (peça nova),
-- peca_ruim ou erro_tecnico (troca).
create or replace function public.resolve_part_request(p_id uuid, p_decision text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.part_requests;
begin
  if not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into r from public.part_requests where id = p_id for update;
  if not found or r.status <> 'pendente' then
    raise exception 'pedido já decidido' using errcode = 'P0001';
  end if;

  if p_decision = 'recusar' then
    update public.part_requests
       set status = 'recusada', resolved_by = (select auth.uid()), resolved_at = now()
     where id = r.id;
  elsif r.kind = 'nova' and p_decision = 'atender' then
    insert into public.part_allocations (os_id, serial, part, user_id)
    values (r.os_id, r.serial, r.part, (select auth.uid()));
    update public.part_requests
       set status = 'atendida', resolved_by = (select auth.uid()), resolved_at = now()
     where id = r.id;
  elsif r.kind = 'troca' and p_decision in ('peca_ruim', 'erro_tecnico') then
    update public.part_allocations set status = 'trocada', swap_reason = p_decision
     where id = r.allocation_id and status = 'alocada';
    insert into public.part_allocations (os_id, serial, part, user_id)
    values (r.os_id, r.serial, r.part, (select auth.uid()));
    update public.part_requests
       set status = 'atendida', resolution = p_decision, resolved_by = (select auth.uid()), resolved_at = now()
     where id = r.id;
  else
    raise exception 'decisão inválida' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.resolve_part_request(uuid, text) from public, anon;
grant execute on function public.resolve_part_request(uuid, text) to authenticated;

-- Pedidos pendentes para o aviso do estoquista. SECURITY DEFINER porque o nome de quem pediu fica em
-- profiles, que cada pessoa só lê do próprio perfil. Mostra o modelo do aparelho, não o ativo.
create or replace function public.pending_part_requests()
returns table (
  id uuid, kind text, part text, os_number text, model text, requester text, created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.kind, r.part, o.os_number, a.model,
         coalesce(nullif(btrim(p.name), ''), p.email), r.created_at
  from public.part_requests r
  join public.service_orders o on o.id = r.os_id
  join public.profiles p on p.id = r.requested_by
  left join public.assets a on a.serial_key = r.serial_key
  where r.status = 'pendente'
    and (select public.has_any_role(array['admin', 'estoquista']::public.user_role[]))
  order by r.created_at;
$$;

revoke all on function public.pending_part_requests() from public, anon;
grant execute on function public.pending_part_requests() to authenticated;
