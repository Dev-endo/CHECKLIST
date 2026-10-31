-- Estoque: o estoquista empresta uma peça de teste direto para um técnico ou desmontador, sem pedido.
-- Rode depois de 20261008000037_test_part_loans.sql. Pode rodar de novo.
-- Ao concluir o checklist, o técnico vê a peça de teste alocada e pede a liberação (trava da 037).

-- Acha a OS do aparelho pelo número informado, ou cria a OS (nova passagem). Interna: só as funções
-- do estoque a chamam.
-- Erros: os_other_serial (OS de outro aparelho), os_not_current (OS antiga do aparelho).
create or replace function public.stock_os(p_serial text, p_os_number text) returns public.service_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(p_serial));
  v_os public.service_orders;
begin
  if v_key = '' or btrim(coalesce(p_os_number, '')) = '' then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into v_os from public.service_orders where os_key = lower(btrim(p_os_number));
  if found then
    if v_os.serial_key <> v_key then
      raise exception 'os_other_serial' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.service_orders n where n.serial_key = v_key and n.created_at > v_os.created_at
    ) then
      raise exception 'os_not_current' using errcode = 'P0001';
    end if;
  else
    insert into public.service_orders (serial, os_number, asset_short_id, user_id)
    values (
      btrim(p_serial), btrim(p_os_number),
      (select a.asset_short_id from public.assets a where a.serial_key = v_key),
      (select auth.uid())
    )
    returning * into v_os;
  end if;
  return v_os;
end;
$$;

revoke all on function public.stock_os(text, text) from public, anon, authenticated;

create or replace function public.allocate_part(p_serial text, p_os_number text, p_part text) returns uuid
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
  v_os := public.stock_os(p_serial, p_os_number);
  insert into public.part_allocations (os_id, serial, part, user_id)
  values (v_os.id, v_os.serial, btrim(p_part), (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.allocate_part(text, text, text) from public, anon;
grant execute on function public.allocate_part(text, text, text) to authenticated;

-- Quem pode receber uma peça de teste: técnicos e desmontadores.
create or replace function public.stock_borrowers() returns table (id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, coalesce(nullif(btrim(p.name), ''), p.email)
  from public.profiles p
  where (p.role in ('tecnico', 'desmontador') or p.extra_roles && array['tecnico', 'desmontador']::public.user_role[])
    and (select public.has_any_role(array['admin', 'estoquista']::public.user_role[]))
  order by 2;
$$;

revoke all on function public.stock_borrowers() from public, anon;
grant execute on function public.stock_borrowers() to authenticated;

-- Empresta a peça de teste para um técnico ou desmontador, na OS do aparelho (cria a OS se o número é novo).
-- Erros: os_other_serial, os_not_current, 23505 (a peça já está emprestada nessa OS), 22023 (quem recebe não é técnico nem desmontador).
create or replace function public.lend_test_part(p_serial text, p_os_number text, p_part text, p_borrower uuid) returns uuid
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
  v_os := public.stock_os(p_serial, p_os_number);
  insert into public.part_loans (os_id, serial, part, borrower, lent_by)
  values (v_os.id, v_os.serial, btrim(p_part), p_borrower, (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.lend_test_part(text, text, text, uuid) from public, anon;
grant execute on function public.lend_test_part(text, text, text, uuid) to authenticated;
