-- Mais de uma função por pessoa: além do papel principal (profiles.role), a pessoa pode ter
-- papéis extras de operação (técnico, desmontador e montador).
-- Rode depois de 20261008000018_desmontador_access.sql. Pode rodar de novo.

alter table public.profiles
  add column if not exists extra_roles public.user_role[] not null default '{}';

alter table public.profiles drop constraint if exists profiles_extra_roles_check;
alter table public.profiles
  add constraint profiles_extra_roles_check
  check (extra_roles <@ array['tecnico', 'desmontador', 'montador']::public.user_role[]);

-- A pessoa tem pelo menos um dos papéis informados, como principal ou extra.
create or replace function public.has_any_role(p_roles public.user_role[]) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and (p.role = any (p_roles) or p.extra_roles && p_roles)
  );
$$;

revoke all on function public.has_any_role(public.user_role[]) from public, anon;
grant execute on function public.has_any_role(public.user_role[]) to authenticated;

-- Manutenção: técnico. Desmontagens: desmontador. Montagem: montador. Admin faz todas.
-- Sempre o dono, e só enquanto pendente.
drop policy if exists "devices_insert_own" on public.devices;
create policy "devices_insert_own" on public.devices
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and phase = 'pendente'
    and (
      (kind = 'manutencao' and (select public.has_any_role(array['tecnico', 'admin']::public.user_role[])))
      or (kind in ('desmontagem', 'desmontagem_tecnica')
        and (select public.has_any_role(array['desmontador', 'admin']::public.user_role[])))
      or (kind = 'montagem' and (select public.has_any_role(array['montador', 'admin']::public.user_role[])))
    )
  );

drop policy if exists "devices_update_own_pending" on public.devices;
create policy "devices_update_own_pending" on public.devices
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and phase = 'pendente'
    and (
      (kind = 'manutencao' and (select public.has_any_role(array['tecnico', 'admin']::public.user_role[])))
      or (kind in ('desmontagem', 'desmontagem_tecnica')
        and (select public.has_any_role(array['desmontador', 'admin']::public.user_role[])))
      or (kind = 'montagem' and (select public.has_any_role(array['montador', 'admin']::public.user_role[])))
    )
  )
  with check (user_id = (select auth.uid()));

drop policy if exists "assets_select" on public.assets;
create policy "assets_select" on public.assets
  for select to authenticated
  using ((select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'montador', 'desmontador']::public.user_role[])));

drop policy if exists "quarantine_insert" on public.quarantine_checks;
create policy "quarantine_insert" on public.quarantine_checks
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.has_any_role(array['montador', 'admin']::public.user_role[]))
  );

-- Quem vem da manutenção ou da desmontagem: só a montagem (e admin/supervisor) consulta.
create or replace function public.assembly_source(p_serial text)
returns table (
  device_id uuid, kind text, destination text, status public.device_status, technician text, concluded_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.kind, d.destination, d.status, coalesce(nullif(btrim(p.name), ''), p.email), d.concluded_at
  from public.devices d
  join public.profiles p on p.id = d.user_id
  where d.kind in ('manutencao', 'desmontagem', 'desmontagem_tecnica')
    and d.phase = 'concluido'
    and lower(btrim(d.serial)) = lower(btrim(p_serial))
    and (select public.has_any_role(array['admin', 'supervisor', 'montador']::public.user_role[]))
  order by d.concluded_at desc
  limit 1;
$$;
