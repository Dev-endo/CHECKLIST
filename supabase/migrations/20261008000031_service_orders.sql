-- Ordens de serviço (OS): toda vez que um aparelho entra no laboratório gera uma OS, e o mesmo ativo pode
-- ter várias. A OS é registrada pelo serial; os checklists do mesmo serial feitos a partir do registro de uma OS
-- e antes do registro da OS seguinte pertencem a ela (desmontagem, manutenção, montagem e quarentena).
-- Rode depois de 20261008000030_collaborator_items.sql (precisa do 20, has_any_role). Pode rodar de novo.

create table if not exists public.service_orders (
  id uuid primary key default gen_random_uuid(),
  serial text not null check (char_length(btrim(serial)) between 1 and 100),
  serial_key text generated always as (lower(btrim(serial))) stored,
  os_number text not null check (char_length(btrim(os_number)) between 1 and 40),
  -- Um número de OS vale uma única vez em todo o sistema.
  os_key text generated always as (lower(btrim(os_number))) stored,
  asset_short_id text,
  user_id uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

create unique index if not exists service_orders_os_key_idx on public.service_orders (os_key);
create index if not exists service_orders_serial_idx on public.service_orders (serial_key, created_at);
create index if not exists service_orders_created_idx on public.service_orders (created_at desc);

alter table public.service_orders enable row level security;

grant select, insert, delete on public.service_orders to authenticated;

-- Qualquer pessoa com função registra a OS (só "Sem função" fica de fora); o registro é de quem criou.
drop policy if exists "service_orders_insert" on public.service_orders;
create policy "service_orders_insert" on public.service_orders
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.has_any_role(
      array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador']::public.user_role[]))
  );

-- Todos do laboratório (e supervisor) veem as OS de um ativo, para saber quantas ele já teve.
drop policy if exists "service_orders_select" on public.service_orders;
create policy "service_orders_select" on public.service_orders
  for select to authenticated
  using ((select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador']::public.user_role[])));

-- Só o admin apaga (ex.: OS registrada no serial errado).
drop policy if exists "service_orders_delete" on public.service_orders;
create policy "service_orders_delete" on public.service_orders
  for delete to authenticated
  using ((select public.current_user_role()) = 'admin');

-- Mapa de uma OS: os dados da OS e tudo o que foi feito no aparelho dentro dela.
-- SECURITY DEFINER porque cada pessoa só lê os próprios checklists; aqui quem trabalha no laboratório
-- (ou supervisor) vê o caminho completo do aparelho.
-- Pertence à OS o checklist do mesmo serial criado a partir do registro dela e antes da OS seguinte.
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
        array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador']::public.user_role[]))
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
