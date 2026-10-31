-- Quarentena: uma aba só, aberta para todo mundo que tem função.
-- Rode depois de 20261008000053_quarantine_pending.sql (precisa de 51 e 52 antes). Pode rodar de novo.
--
-- Todos os papéis (menos "Sem função") veem a lista de aparelhos aguardando e registram a quarentena.

create or replace function public.quarantine_pending()
returns table (
  serial text,
  os_number text,
  model text,
  unit text,
  technician text,
  sent_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.serial, o.os_number, a.model, a.asset_short_id,
         coalesce(nullif(btrim(p.name), ''), p.email) as technician,
         s.finished_at as sent_at
  from public.repair_stages s
  join public.service_orders o on o.id = s.os_id
  join public.profiles p on p.id = s.technician_id
  left join public.assets a on a.serial_key = s.serial_key
  where s.stage = 'manutencao'
    and s.status = 'concluida'
    and s.outcome = 'quarentena'
    and (select public.has_any_role(
      array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]))
    and not exists (
      select 1 from public.quarantine_checks q
      where lower(btrim(q.serial)) = s.serial_key and q.created_at >= s.finished_at
    )
    and not exists (
      select 1 from public.service_orders newer
      where newer.serial_key = s.serial_key and newer.created_at > o.created_at
    )
  order by s.finished_at
  limit 1000;
$$;

revoke all on function public.quarantine_pending() from public, anon;
grant execute on function public.quarantine_pending() to authenticated;

drop policy if exists "quarantine_insert" on public.quarantine_checks;
create policy "quarantine_insert" on public.quarantine_checks
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.has_any_role(
      array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]))
  );

-- Todos veem os números da quarentena (antes, cada um via só os seus; admin e supervisor viam todos).
drop policy if exists "quarantine_select" on public.quarantine_checks;
create policy "quarantine_select" on public.quarantine_checks
  for select to authenticated
  using ((select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[])));
