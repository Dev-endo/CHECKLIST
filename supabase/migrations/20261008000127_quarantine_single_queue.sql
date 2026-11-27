-- Quarentena: a lista Aguardando e o status "Em quarentena" do Dia Laboratório passam a ser a mesma fila.
-- Rode depois de 20261008000126_lab_remove_open_checklist.sql. Pode rodar de novo.
--
-- Antes, a lista Aguardando só via os envios da manutenção e as inclusões da conferência. Um ativo podia estar "Em
-- quarentena" no Dia Laboratório e fora da lista (ex.: retirado na conferência de 25/11), e a aba Quarentena barrava
-- o serial ("Serial não registrado"). Agora quarantine_pending_rows (e quarantine_pending, que a lê) inclui também as
-- passagens abertas com status quarentena. Ao bipar aprovado ou reprovado, o gatilho lab_on_quarantine tira o ativo
-- da quarentena e ele sai da lista.

create or replace function public.quarantine_pending_rows()
returns table (serial text, os_number text, model text, unit text, technician text, sent_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    -- Enviados pela manutenção (corpo da migration 58) que não foram retirados depois do envio.
    select s.serial, s.os_number, a.model, a.asset_short_id,
           coalesce(nullif(btrim(p.name), ''), p.email) as technician,
           s.sent_at
    from public.repair_quarantine_sends() s
    join public.profiles p on p.id = s.sender_id
    left join public.assets a on a.serial_key = s.serial_key
    where not exists (
        select 1 from public.quarantine_checks q
        where lower(btrim(q.serial)) = s.serial_key and q.created_at >= s.sent_at
      )
      and not exists (
        select 1 from public.service_orders newer
        where newer.serial_key = s.serial_key and newer.created_at > s.os_created
      )
      and not exists (
        select 1 from public.quarantine_dismissals d where d.serial_key = s.serial_key and d.dismissed_at >= s.sent_at
      )
    union all
    -- Incluídos na conferência (o mais recente de cada serial), até serem bipados ou retirados.
    select m.serial,
           coalesce((select so.os_number from public.service_orders so where so.serial_key = m.serial_key
                      order by so.created_at desc limit 1), '—'),
           a.model, a.asset_short_id,
           'Incluído na conferência',
           m.added_at
    from (select distinct on (x.serial_key) x.* from public.quarantine_manual x order by x.serial_key, x.added_at desc) m
    left join public.assets a on a.serial_key = m.serial_key
    where not exists (
        select 1 from public.quarantine_checks q where lower(btrim(q.serial)) = m.serial_key and q.created_at >= m.added_at
      )
      and not exists (
        select 1 from public.quarantine_dismissals d where d.serial_key = m.serial_key and d.dismissed_at >= m.added_at
      )
      -- Já está na lista pelo envio da manutenção: não repete.
      and not exists (
        select 1 from public.repair_quarantine_sends() s
         where s.serial_key = m.serial_key
           and not exists (select 1 from public.quarantine_checks q where lower(btrim(q.serial)) = s.serial_key and q.created_at >= s.sent_at)
           and not exists (select 1 from public.service_orders newer where newer.serial_key = s.serial_key and newer.created_at > s.os_created)
           and not exists (select 1 from public.quarantine_dismissals d where d.serial_key = s.serial_key and d.dismissed_at >= s.sent_at)
      )
  )
  select * from base
  union all
  -- Fila única: o ativo que o Dia Laboratório marca como em quarentena (passagem aberta) está na lista Aguardando,
  -- mesmo sem o envio da manutenção ou tendo sido retirado numa conferência anterior.
  select a.serial,
         coalesce((select so.os_number from public.service_orders so where so.id = a.os_id), '—'),
         coalesce(a.model, ast.model),
         coalesce(a.unit_id, ast.asset_short_id),
         coalesce(public.lab_name(a.last_technician_id), 'Dia Laboratório'),
         a.last_move_at
    from public.lab_assets a
    left join lateral (select x.model, x.asset_short_id from public.assets x where x.serial_key = a.serial_key limit 1) ast on true
   where a.status = 'quarentena' and a.exited_at is null
     and a.serial_key not in (select lower(btrim(b.serial)) from base b);
$$;

revoke all on function public.quarantine_pending_rows() from public, anon, authenticated;
