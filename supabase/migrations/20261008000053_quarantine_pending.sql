-- Reparo: aba Quarentena com os aparelhos que a manutenção enviou e ainda não foram bipados.
-- Rode depois de 20261008000052_stage1_destinations_glass.sql. Pode rodar de novo.
--
-- A quarentena continua funcionando como antes (quarantine_checks: serial bipado + aprovado ou reprovado).
-- Esta função só lista o que a manutenção do Reparo mandou para a quarentena e ainda não tem resultado:
-- o aparelho sai da lista quando o serial é bipado e marcado como aprovado OU reprovado (depois do envio).
-- Um aparelho que voltou ao laboratório com OS nova deixa de ser esperado pela OS anterior.

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
      array['admin', 'supervisor', 'tecnico', 'montador', 'estoquista', 'analista']::public.user_role[]))
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

-- Quem tem o papel de montador (principal ou somado) também registra a quarentena; antes só valia o papel principal.
drop policy if exists "quarantine_insert" on public.quarantine_checks;
create policy "quarantine_insert" on public.quarantine_checks
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.has_any_role(array['montador', 'admin']::public.user_role[]))
  );
