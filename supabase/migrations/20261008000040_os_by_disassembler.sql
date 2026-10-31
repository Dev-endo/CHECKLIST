-- A OS passa a ser registrada pelo desmontador (e pelo admin), não mais pelo estoquista.
-- Rode depois de 20261008000039_release_allocations.sql. Pode rodar de novo.
--
-- O estoquista só usa a OS atual do aparelho (a mais recente do serial) ao alocar ou emprestar peça.
-- Sem OS registrada, a alocação é recusada (erro no_os): o desmontador registra a OS primeiro.
-- Cada passagem do aparelho pelo laboratório continua tendo uma OS nova (o desmontador registra outra).

drop policy if exists "service_orders_insert" on public.service_orders;
create policy "service_orders_insert" on public.service_orders
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.has_any_role(array['admin', 'desmontador']::public.user_role[]))
  );

-- Funções antigas do estoque (recebiam o número da OS).
drop function if exists public.allocate_part(text, text, text);
drop function if exists public.lend_test_part(text, text, text, uuid);
drop function if exists public.stock_os(text, text);

-- A OS atual do aparelho. Interna: só as funções do estoque a chamam.
-- Erro: no_os (o aparelho ainda não tem OS registrada).
create or replace function public.current_os(p_serial text) returns public.service_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
begin
  select * into v_os from public.service_orders
   where serial_key = lower(btrim(coalesce(p_serial, ''))) order by created_at desc limit 1;
  if not found then
    raise exception 'no_os' using errcode = 'P0001';
  end if;
  return v_os;
end;
$$;

revoke all on function public.current_os(text) from public, anon, authenticated;

-- Aloca a peça no aparelho, na OS atual. A peça já fica liberada no aparelho.
-- Erros: no_os, 23505 (a peça já está alocada nessa OS).
create or replace function public.allocate_part(p_serial text, p_part text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_id uuid;
begin
  if not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if btrim(coalesce(p_part, '')) = '' then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  v_os := public.current_os(p_serial);
  insert into public.part_allocations (os_id, serial, part, user_id)
  values (v_os.id, v_os.serial, btrim(p_part), (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.allocate_part(text, text) from public, anon;
grant execute on function public.allocate_part(text, text) to authenticated;

-- Empresta a peça de teste para um técnico ou desmontador, na OS atual do aparelho.
-- Erros: no_os, 23505 (a peça já está emprestada nessa OS), 22023 (quem recebe não é técnico nem desmontador).
create or replace function public.lend_test_part(p_serial text, p_part text, p_borrower uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_id uuid;
begin
  if not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if btrim(coalesce(p_part, '')) = '' or not exists (
    select 1 from public.profiles p
    where p.id = p_borrower
      and (p.role in ('tecnico', 'desmontador') or p.extra_roles && array['tecnico', 'desmontador']::public.user_role[])
  ) then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  v_os := public.current_os(p_serial);
  insert into public.part_loans (os_id, serial, part, borrower, lent_by)
  values (v_os.id, v_os.serial, btrim(p_part), p_borrower, (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.lend_test_part(text, text, uuid) from public, anon;
grant execute on function public.lend_test_part(text, text, uuid) to authenticated;
