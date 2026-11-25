-- Aba Quarentena > Aguardando: conferência física. Dá para tirar da lista quem não está na quarentena (sem gravar
-- aprovado/reprovado) e incluir quem está fisicamente lá mas o sistema não esperava. Rode depois de
-- 20261008000122_glass_open_counts_as_glass.sql. Pode rodar de novo.
--
--   * quarantine_dismissals: o serial sai da lista Aguardando; um envio novo para a quarentena (depois da retirada)
--     volta a aparecer normalmente.
--   * quarantine_manual: o serial entra na lista Aguardando ("Incluído na conferência") até ser bipado.
--   * quarantine_pending_rows: a lista sem a checagem de papel (uso interno e scripts); quarantine_pending() continua
--     com o mesmo retorno, agora com as retiradas e as inclusões.

create table if not exists public.quarantine_dismissals (
  serial_key text primary key,
  dismissed_at timestamptz not null default now(),
  dismissed_by uuid references public.profiles (id)
);

create table if not exists public.quarantine_manual (
  id uuid primary key default gen_random_uuid(),
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  added_at timestamptz not null default now(),
  added_by uuid references public.profiles (id)
);

create index if not exists quarantine_manual_key_idx on public.quarantine_manual (serial_key, added_at desc);

alter table public.quarantine_dismissals enable row level security;
alter table public.quarantine_manual enable row level security;
revoke all on public.quarantine_dismissals, public.quarantine_manual from anon, authenticated;

create or replace function public.quarantine_pending_rows()
returns table (serial text, os_number text, model text, unit text, technician text, sent_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
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
    );
$$;

revoke all on function public.quarantine_pending_rows() from public, anon, authenticated;

create or replace function public.quarantine_pending()
returns table (serial text, os_number text, model text, unit text, technician text, sent_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  -- Um por serial (o envio mais recente).
  select u.serial, u.os_number, u.model, u.unit, u.technician, u.sent_at
    from (select distinct on (lower(btrim(r.serial))) r.*
            from public.quarantine_pending_rows() r
           order by lower(btrim(r.serial)), r.sent_at desc) u
   where (select public.has_any_role(
       array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]))
   order by u.sent_at
   limit 1000;
$$;

revoke all on function public.quarantine_pending() from public, anon;
grant execute on function public.quarantine_pending() to authenticated;
