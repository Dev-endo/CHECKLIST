-- Login só com Google, papéis (admin / supervisor / colaborador) e checklists por usuário.

create type public.user_role as enum ('admin', 'supervisor', 'colaborador');
create type public.device_phase as enum ('pendente', 'concluido');

-- Um perfil por usuário do Supabase Auth, criado pelo trigger no primeiro login.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  email text not null default '',
  role public.user_role not null default 'colaborador',
  created_at timestamptz not null default now()
);

comment on table public.profiles is 'Usuários do app (nome, e-mail e papel).';

-- Papel pré-definido por e-mail, aplicado no primeiro login. Sem policies:
-- só é lida pelo trigger e por quem administra o banco.
create table public.role_presets (
  email text primary key check (email = lower(email)),
  role public.user_role not null
);
alter table public.role_presets enable row level security;
revoke all on public.role_presets from anon, authenticated;

insert into public.role_presets (email, role) values ('lucasdosanjos1830@gmail.com', 'admin');

create function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.email, ''),
    coalesce((select role from public.role_presets where email = lower(new.email)), 'colaborador')
  );
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Papel do usuário logado, sem recursão de RLS nas policies.
create function public.current_user_role() returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = auth.uid()
$$;
revoke all on function public.current_user_role() from public, anon;
grant execute on function public.current_user_role() to authenticated;

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
-- Só o papel pode ser alterado, e só pelo admin, nunca na própria conta.
grant update (role) on public.profiles to authenticated;

create policy "profiles_select" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.current_user_role()) in ('admin', 'supervisor'));

create policy "profiles_admin_update" on public.profiles
  for update to authenticated
  using ((select public.current_user_role()) = 'admin' and id <> (select auth.uid()))
  with check ((select public.current_user_role()) = 'admin');

-- Perfis de quem já existir no Auth antes desta migration.
insert into public.profiles (id, name, email, role)
select
  u.id,
  coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', ''),
  coalesce(u.email, ''),
  coalesce((select p.role from public.role_presets p where p.email = lower(u.email)), 'colaborador')
from auth.users u
on conflict (id) do nothing;

-- Checklists: dados anteriores (acesso público, sem dono) são descartados.
truncate public.devices;

alter table public.devices
  add column user_id uuid not null references public.profiles (id) on delete cascade,
  add column phase public.device_phase not null default 'pendente',
  add column concluded_at timestamptz,
  -- Só se grava o aparelho depois de identificado.
  add constraint devices_identified check (
    btrim(model) <> '' and btrim(serial) <> '' and btrim(technician) <> ''
  );

create index devices_user_id_idx on public.devices (user_id, updated_at desc);
create index devices_created_at_idx on public.devices (created_at desc);

-- created_at e user_id são imutáveis; updated_at e concluded_at vêm do servidor.
create or replace function public.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := old.created_at;
  new.user_id := old.user_id;
  new.updated_at := now();
  if new.phase = 'concluido' and old.phase = 'pendente' then
    new.concluded_at := now();
  else
    new.concluded_at := old.concluded_at;
  end if;
  return new;
end;
$$;

drop policy "devices_public_select" on public.devices;
drop policy "devices_public_insert" on public.devices;
drop policy "devices_public_update" on public.devices;

revoke all on public.devices from anon;

-- Colaborador: só os próprios. Supervisor e admin: leem todos, sem editar.
-- Edição só do dono e só enquanto pendente; concluído é definitivo.
create policy "devices_select" on public.devices
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.current_user_role()) in ('admin', 'supervisor'));

create policy "devices_insert_own" on public.devices
  for insert to authenticated
  with check (user_id = (select auth.uid()) and phase = 'pendente');

create policy "devices_update_own_pending" on public.devices
  for update to authenticated
  using (user_id = (select auth.uid()) and phase = 'pendente')
  with check (user_id = (select auth.uid()));
