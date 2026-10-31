-- Estoque: peça alocada já fica liberada no aparelho; pedido do técnico/desmontador trava o checklist até
-- o estoquista responder; as desmontagens ganham o destino "alocação de peça".
-- Rode depois de 20261008000038_direct_test_loan.sql. Pode rodar de novo (inclusive se uma versão anterior
-- deste arquivo já foi rodada: ela é ajustada para a regra final).
--
-- Regras:
--   * O estoquista aloca a peça e ela já fica liberada no aparelho (status 'liberada').
--   * Se o técnico ou o desmontador pedir peça (nova, teste ou troca), o checklist de manutenção não conclui
--     até o estoquista liberar a peça (ou recusar o pedido).
--   * Peça de teste emprestada também trava o checklist até ser liberada para uso ou devolvida.

-- Novo destino das desmontagens: enviar para alocação de peça (o aparelho vai ao estoque).
alter table public.devices drop constraint if exists devices_destination_check;
alter table public.devices
  add constraint devices_destination_check
  check (destination in ('montagem', 'vidro', 'analise', 'bloqueio', 'quarentena', 'manutencao', 'pt', 'aguardando_peca', 'alocacao_peca'));

-- Limpa a ideia de "alocada e ainda não liberada" (de uma versão anterior deste arquivo).
drop function if exists public.release_allocation(uuid);
drop function if exists public.cancel_allocation(uuid);
delete from public.part_requests where kind = 'liberacao';
update public.part_allocations set status = 'liberada' where status = 'alocada';

alter table public.part_allocations drop constraint if exists part_allocations_status_check;
alter table public.part_allocations
  add constraint part_allocations_status_check
  check (status in ('liberada', 'concluida', 'devolvida', 'trocada'));
alter table public.part_allocations alter column status set default 'liberada';
alter table public.part_allocations drop column if exists released_at;
alter table public.part_allocations drop column if exists released_by;

-- A mesma peça não fica duas vezes na OS enquanto a primeira estiver com o técnico.
drop index if exists public.part_allocations_open_idx;
create unique index part_allocations_open_idx
  on public.part_allocations (os_id, part) where status = 'liberada';

alter table public.part_requests drop constraint if exists part_requests_kind_check;
alter table public.part_requests
  add constraint part_requests_kind_check check (kind in ('nova', 'teste', 'troca', 'uso', 'devolucao'));

-- O técnico conclui ou devolve a peça que está com ele.
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
   where id = p_id and status = 'liberada';
  if not found then
    raise exception 'peça já fechada' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.complete_allocation(uuid, text) from public, anon;
grant execute on function public.complete_allocation(uuid, text) to authenticated;

-- Pedido de peça: nova, teste, troca (de peça liberada), uso e devolução (de peça de teste emprestada).
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
  -- Trocar peça e usar a peça de teste são decisões do técnico.
  if p_kind in ('uso', 'troca') and not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  select * into v_os from public.service_orders where serial_key = v_key order by created_at desc limit 1;
  if not found then
    raise exception 'no_os' using errcode = 'P0001';
  end if;

  if p_kind = 'troca' then
    select a.part into v_part from public.part_allocations a
    where a.id = p_allocation_id and a.os_id = v_os.id and a.status = 'liberada';
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

-- Decisão do estoquista: atender o pedido libera a peça para o aparelho.
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
     where id = r.allocation_id and status = 'liberada';
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

-- Aparelhos que as desmontagens enviaram para alocação de peça e que o estoque ainda não tocou
-- (nada alocado ou emprestado depois, e nenhum checklist mais novo do mesmo serial).
-- SECURITY DEFINER: cada pessoa só lê os próprios checklists. Mostra o modelo, não o ativo.
create or replace function public.awaiting_allocation()
returns table (id uuid, kind text, model text, sender text, since timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.kind, a.model, coalesce(nullif(btrim(p.name), ''), p.email), d.concluded_at
  from public.devices d
  join public.profiles p on p.id = d.user_id
  left join public.assets a on a.serial_key = lower(btrim(d.serial))
  where d.phase = 'concluido'
    and d.destination = 'alocacao_peca'
    and (select public.has_any_role(array['admin', 'estoquista']::public.user_role[]))
    and not exists (
      select 1 from public.devices x
      where lower(btrim(x.serial)) = lower(btrim(d.serial)) and x.phase = 'concluido' and x.concluded_at > d.concluded_at
    )
    and not exists (
      select 1 from public.part_allocations pa
      where pa.serial_key = lower(btrim(d.serial)) and pa.created_at > d.concluded_at
    )
    and not exists (
      select 1 from public.part_loans l
      where l.serial_key = lower(btrim(d.serial)) and l.created_at > d.concluded_at
    )
  order by d.concluded_at;
$$;

revoke all on function public.awaiting_allocation() from public, anon;
grant execute on function public.awaiting_allocation() to authenticated;

-- Trava: o checklist de manutenção não conclui, na OS atual do aparelho, com peça de teste emprestada nem com
-- pedido de peça (nova, teste ou troca) esperando o estoquista.
create or replace function public.block_conclusion_with_test_part() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os uuid;
begin
  if new.kind = 'manutencao' and new.phase = 'concluido'
     and (tg_op = 'INSERT' or old.phase is distinct from 'concluido') then
    select o.id into v_os from public.service_orders o
     where o.serial_key = lower(btrim(new.serial)) order by o.created_at desc limit 1;
    if v_os is not null then
      if exists (select 1 from public.part_loans l where l.os_id = v_os and l.status = 'emprestada') then
        raise exception 'test_part_out' using errcode = 'P0001';
      end if;
      if exists (
        select 1 from public.part_requests r
        where r.os_id = v_os and r.status = 'pendente' and r.kind in ('nova', 'teste', 'troca')
      ) then
        raise exception 'request_pending' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;
