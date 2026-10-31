-- Estoque, etapa 1: o estoquista aloca peças nos aparelhos e é ele quem registra a OS.
-- Rode depois de 20261008000034_role_estoquista.sql (em execução separada). Pode rodar de novo.
--
-- Cada passagem do aparelho pelo laboratório tem uma OS nova (o serial pode se repetir, a OS não).
-- A OS passa a ser registrada só pelo estoquista (e pelo admin), na alocação da peça. Só o admin corrige
-- o número de uma OS registrada errada.

-- O estoquista pode ser também técnico, desmontador ou montador.
alter table public.profiles drop constraint if exists profiles_extra_roles_check;
alter table public.profiles
  add constraint profiles_extra_roles_check
  check (extra_roles <@ array['tecnico', 'desmontador', 'montador', 'estoquista']::public.user_role[]);

-- O estoquista bipa o serial e vê o modelo do aparelho.
drop policy if exists "assets_select" on public.assets;
create policy "assets_select" on public.assets
  for select to authenticated
  using ((select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'montador', 'desmontador', 'estoquista']::public.user_role[])));

-- OS: só estoquista e admin registram (técnico, desmontador e montador deixam de registrar).
drop policy if exists "service_orders_insert" on public.service_orders;
create policy "service_orders_insert" on public.service_orders
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.has_any_role(array['admin', 'estoquista']::public.user_role[]))
  );

drop policy if exists "service_orders_select" on public.service_orders;
create policy "service_orders_select" on public.service_orders
  for select to authenticated
  using ((select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista']::public.user_role[])));

-- Peças alocadas a um aparelho, dentro de uma OS.
-- status: alocada (com o técnico), concluida (aplicada e finalizada), devolvida (não foi usada),
-- trocada (voltou ruim ou danificada). As outras etapas (teste, empréstimo) entram nas próximas migrations.
create table if not exists public.part_allocations (
  id uuid primary key default gen_random_uuid(),
  os_id uuid not null references public.service_orders (id) on delete cascade,
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  part text not null check (char_length(btrim(part)) between 1 and 60),
  status text not null default 'alocada' check (status in ('alocada', 'concluida', 'devolvida', 'trocada')),
  user_id uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

-- A mesma peça não é alocada duas vezes na mesma OS enquanto a primeira ainda está alocada.
create unique index if not exists part_allocations_open_idx
  on public.part_allocations (os_id, part) where status = 'alocada';
create index if not exists part_allocations_serial_idx on public.part_allocations (serial_key, created_at);

alter table public.part_allocations enable row level security;

-- Só leitura direta: as gravações passam pelas funções abaixo.
grant select on public.part_allocations to authenticated;

drop policy if exists "part_allocations_select" on public.part_allocations;
create policy "part_allocations_select" on public.part_allocations
  for select to authenticated
  using ((select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista']::public.user_role[])));

-- Aloca uma peça no aparelho. Se o número da OS não existe, cria a OS (nova passagem do aparelho);
-- se existe, tem que ser a OS mais recente do mesmo serial.
-- Erros: os_other_serial (OS de outro aparelho), os_not_current (OS antiga do aparelho),
-- 23505 (a peça já está alocada nessa OS).
create or replace function public.allocate_part(p_serial text, p_os_number text, p_part text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(p_serial));
  v_os public.service_orders;
  v_id uuid;
begin
  if not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_key = '' or btrim(coalesce(p_os_number, '')) = '' or btrim(coalesce(p_part, '')) = '' then
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

  insert into public.part_allocations (os_id, serial, part, user_id)
  values (v_os.id, v_os.serial, btrim(p_part), (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.allocate_part(text, text, text) from public, anon;
grant execute on function public.allocate_part(text, text, text) to authenticated;

-- Só o admin corrige o número de uma OS registrada errada.
-- Erros: 42501 (não é admin), 23505 (o número já existe em outra OS).
create or replace function public.correct_service_order(p_os_id uuid, p_os_number text) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select public.current_user_role()) <> 'admin' then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if btrim(coalesce(p_os_number, '')) = '' or char_length(btrim(p_os_number)) > 40 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  update public.service_orders set os_number = btrim(p_os_number) where id = p_os_id;
end;
$$;

revoke all on function public.correct_service_order(uuid, text) from public, anon;
grant execute on function public.correct_service_order(uuid, text) to authenticated;

-- O mapa da OS também é visto pelo estoquista.
create or replace function public.os_map(p_os_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with o as (
    select s.id, s.serial, s.serial_key, s.os_number, s.asset_short_id, s.user_id, s.created_at,
           row_number() over (partition by s.serial_key order by s.created_at) as ordinal,
           count(*) over (partition by s.serial_key) as total,
           lead(s.created_at) over (partition by s.serial_key order by s.created_at) as next_at
    from public.service_orders s
  ),
  me as (
    select * from o
    where id = p_os_id
      and (select public.has_any_role(
        array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista']::public.user_role[]))
  ),
  steps as (
    select d.kind, d.phase::text as phase, d.status::text as status, d.destination,
           coalesce(nullif(btrim(p.name), ''), p.email) as person,
           d.created_at, d.concluded_at, d.failed_items, d.faulty_parts, d.notes,
           d.consumption_note, d.pt_note
    from me
    join public.devices d
      on lower(btrim(d.serial)) = me.serial_key
     and d.created_at >= me.created_at
     and (me.next_at is null or d.created_at < me.next_at)
    join public.profiles p on p.id = d.user_id
  ),
  quar as (
    select coalesce(nullif(btrim(p.name), ''), p.email) as person, q.result, q.created_at
    from me
    join public.quarantine_checks q
      on lower(btrim(q.serial)) = me.serial_key
     and q.created_at >= me.created_at
     and (me.next_at is null or q.created_at < me.next_at)
    join public.profiles p on p.id = q.user_id
  )
  select jsonb_build_object(
    'id', me.id,
    'os_number', me.os_number,
    'serial', me.serial,
    'unit', coalesce(me.asset_short_id, a.asset_short_id),
    'model', a.model,
    'created_at', me.created_at,
    'registered_by', (select coalesce(nullif(btrim(p.name), ''), p.email) from public.profiles p where p.id = me.user_id),
    'ordinal', me.ordinal,
    'total', me.total,
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', st.kind, 'phase', st.phase, 'status', st.status, 'destination', st.destination,
        'person', st.person, 'created_at', st.created_at, 'concluded_at', st.concluded_at,
        'failures', to_jsonb(st.failed_items), 'parts', st.faulty_parts, 'notes', st.notes,
        'consumption_note', st.consumption_note, 'pt_note', st.pt_note
      ) order by coalesce(st.concluded_at, st.created_at))
      from steps st
    ), '[]'::jsonb),
    'quarantine', coalesce((
      select jsonb_agg(jsonb_build_object('person', qq.person, 'result', qq.result, 'at', qq.created_at)
                       order by qq.created_at)
      from quar qq
    ), '[]'::jsonb)
  )
  from me
  left join public.assets a on a.serial_key = me.serial_key;
$$;

revoke all on function public.os_map(uuid) from public, anon;
grant execute on function public.os_map(uuid) to authenticated;
