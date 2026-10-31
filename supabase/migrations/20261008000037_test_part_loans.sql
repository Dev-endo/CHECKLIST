-- Estoque, etapa 3: peça de teste emprestada, liberação para uso e trava do checklist de manutenção.
-- Rode depois de 20261008000036_part_requests.sql. Pode rodar de novo.
--
-- Fluxo da peça de teste:
--   1. Técnico ou desmontador pede (part_requests.kind = 'teste'); o estoquista empresta -> part_loans 'emprestada'.
--   2. Enquanto a peça estiver emprestada, o checklist de manutenção do aparelho NÃO conclui (trava também aqui no banco).
--   3. O técnico decide: usar na manutenção (pedido 'uso') ou devolver (pedido 'devolucao').
--      uso       -> o estoquista libera: a peça vira alocada na OS (em_uso) e o técnico a conclui no balão.
--      devolucao -> o estoquista confirma que a peça voltou: devolvida. Também pode registrar a devolução direto.

create table if not exists public.part_loans (
  id uuid primary key default gen_random_uuid(),
  os_id uuid not null references public.service_orders (id) on delete cascade,
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  part text not null check (char_length(btrim(part)) between 1 and 60),
  -- Com quem a peça está.
  borrower uuid not null references public.profiles (id),
  lent_by uuid not null default auth.uid() references public.profiles (id),
  status text not null default 'emprestada' check (status in ('emprestada', 'devolvida', 'em_uso')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create unique index if not exists part_loans_open_idx on public.part_loans (os_id, part) where status = 'emprestada';
create index if not exists part_loans_serial_idx on public.part_loans (serial_key, created_at);

alter table public.part_loans enable row level security;
grant select on public.part_loans to authenticated;

drop policy if exists "part_loans_select" on public.part_loans;
create policy "part_loans_select" on public.part_loans
  for select to authenticated
  using ((select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista']::public.user_role[])));

-- Pedidos novos: uso (usar a peça de teste na manutenção) e devolucao (devolver a peça de teste).
alter table public.part_requests
  add column if not exists loan_id uuid references public.part_loans (id) on delete cascade;
alter table public.part_requests drop constraint if exists part_requests_kind_check;
alter table public.part_requests
  add constraint part_requests_kind_check check (kind in ('nova', 'teste', 'troca', 'uso', 'devolucao'));

-- Pedido de peça (agora também uso e devolução de peça de teste).
-- Erros: no_os (aparelho sem OS do estoque), 23505 (pedido igual já pendente).
drop function if exists public.request_part(text, text, text, uuid);
create or replace function public.request_part(
  p_serial text, p_part text, p_kind text, p_allocation_id uuid default null, p_loan_id uuid default null
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
  if p_kind not in ('nova', 'teste', 'troca', 'uso', 'devolucao') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  -- Usar a peça de teste na manutenção é decisão do técnico.
  if p_kind = 'uso' and not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
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
  elsif p_kind in ('uso', 'devolucao') then
    select l.part into v_part from public.part_loans l
    where l.id = p_loan_id and l.os_id = v_os.id and l.status = 'emprestada';
    if not found then
      raise exception 'dados incompletos' using errcode = '22023';
    end if;
  elsif v_part = '' then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;

  insert into public.part_requests (os_id, serial, part, kind, allocation_id, loan_id, requested_by)
  values (v_os.id, v_os.serial, v_part, p_kind, p_allocation_id, p_loan_id, (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.request_part(text, text, text, uuid, uuid) from public, anon;
grant execute on function public.request_part(text, text, text, uuid, uuid) to authenticated;

-- Decisão do estoquista. p_decision: recusar (qualquer pedido); atender (nova: aloca; teste: empresta;
-- uso: libera para uso; devolucao: confirma a devolução); peca_ruim / erro_tecnico (troca).
create or replace function public.resolve_part_request(p_id uuid, p_decision text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.part_requests;
  v_me uuid := (select auth.uid());
begin
  if not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into r from public.part_requests where id = p_id for update;
  if not found or r.status <> 'pendente' then
    raise exception 'pedido já decidido' using errcode = 'P0001';
  end if;

  if p_decision = 'recusar' then
    update public.part_requests set status = 'recusada', resolved_by = v_me, resolved_at = now() where id = r.id;
    return;
  end if;

  if r.kind = 'nova' and p_decision = 'atender' then
    insert into public.part_allocations (os_id, serial, part, user_id) values (r.os_id, r.serial, r.part, v_me);
    update public.part_requests set status = 'atendida', resolved_by = v_me, resolved_at = now() where id = r.id;

  elsif r.kind = 'troca' and p_decision in ('peca_ruim', 'erro_tecnico') then
    update public.part_allocations set status = 'trocada', swap_reason = p_decision
     where id = r.allocation_id and status = 'alocada';
    insert into public.part_allocations (os_id, serial, part, user_id) values (r.os_id, r.serial, r.part, v_me);
    update public.part_requests
       set status = 'atendida', resolution = p_decision, resolved_by = v_me, resolved_at = now()
     where id = r.id;

  elsif r.kind = 'teste' and p_decision = 'atender' then
    insert into public.part_loans (os_id, serial, part, borrower, lent_by)
    values (r.os_id, r.serial, r.part, r.requested_by, v_me);
    update public.part_requests set status = 'atendida', resolved_by = v_me, resolved_at = now() where id = r.id;

  elsif r.kind = 'uso' and p_decision = 'atender' then
    update public.part_loans set status = 'em_uso', closed_at = now() where id = r.loan_id and status = 'emprestada';
    if not found then
      raise exception 'pedido já decidido' using errcode = 'P0001';
    end if;
    insert into public.part_allocations (os_id, serial, part, user_id) values (r.os_id, r.serial, r.part, v_me);
    update public.part_requests set status = 'atendida', resolved_by = v_me, resolved_at = now() where id = r.id;
    -- Se a devolução também estava pedida, ela perde o sentido.
    update public.part_requests set status = 'recusada', resolved_by = v_me, resolved_at = now()
     where loan_id = r.loan_id and status = 'pendente' and id <> r.id;

  elsif r.kind = 'devolucao' and p_decision = 'atender' then
    update public.part_loans set status = 'devolvida', closed_at = now() where id = r.loan_id and status = 'emprestada';
    if not found then
      raise exception 'pedido já decidido' using errcode = 'P0001';
    end if;
    update public.part_requests set status = 'atendida', resolved_by = v_me, resolved_at = now() where id = r.id;
    update public.part_requests set status = 'recusada', resolved_by = v_me, resolved_at = now()
     where loan_id = r.loan_id and status = 'pendente' and id <> r.id;

  else
    raise exception 'decisão inválida' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.resolve_part_request(uuid, text) from public, anon;
grant execute on function public.resolve_part_request(uuid, text) to authenticated;

-- Registrar a devolução direto na janela de peças emprestadas (sem pedido do técnico).
create or replace function public.return_loan(p_loan_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  update public.part_loans set status = 'devolvida', closed_at = now() where id = p_loan_id and status = 'emprestada';
  if not found then
    raise exception 'pedido já decidido' using errcode = 'P0001';
  end if;
  update public.part_requests set status = 'recusada', resolved_by = (select auth.uid()), resolved_at = now()
   where loan_id = p_loan_id and status = 'pendente';
end;
$$;

revoke all on function public.return_loan(uuid) from public, anon;
grant execute on function public.return_loan(uuid) to authenticated;

-- Peças emprestadas para teste e com quem estão (janela do estoquista). SECURITY DEFINER pelo nome em profiles.
create or replace function public.open_part_loans()
returns table (id uuid, part text, model text, os_number text, borrower text, since timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.part, a.model, o.os_number,
         coalesce(nullif(btrim(p.name), ''), p.email), l.created_at
  from public.part_loans l
  join public.service_orders o on o.id = l.os_id
  join public.profiles p on p.id = l.borrower
  left join public.assets a on a.serial_key = l.serial_key
  where l.status = 'emprestada'
    and (select public.has_any_role(array['admin', 'estoquista']::public.user_role[]))
  order by l.created_at;
$$;

revoke all on function public.open_part_loans() from public, anon;
grant execute on function public.open_part_loans() to authenticated;

-- Trava: o checklist de manutenção não conclui enquanto o aparelho tiver peça de teste emprestada na OS atual.
create or replace function public.block_conclusion_with_test_part() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'manutencao' and new.phase = 'concluido'
     and (tg_op = 'INSERT' or old.phase is distinct from 'concluido') then
    if exists (
      select 1 from public.part_loans l
      where l.status = 'emprestada'
        and l.serial_key = lower(btrim(new.serial))
        and l.os_id = (
          select o.id from public.service_orders o
          where o.serial_key = lower(btrim(new.serial)) order by o.created_at desc limit 1
        )
    ) then
      raise exception 'test_part_out' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists devices_block_test_part on public.devices;
create trigger devices_block_test_part
  before insert or update on public.devices
  for each row execute function public.block_conclusion_with_test_part();
