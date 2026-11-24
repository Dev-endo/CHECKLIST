-- Reprovados: guarda cada consulta feita na aba Reprovados (serial, quando, quem registrou e os responsáveis da hora)
-- para a Análise mostrar o histórico, já que a lista da aba some depois de bipada.
-- Rode depois de 20261008000103_dashboard_reprovados.sql. Pode rodar de novo.
--
--   * reprovados_register(p_serials): para cada serial grava uma linha com o retrato dos responsáveis naquele momento
--     (os mesmos da consulta da aba: responsável, desmontagem, checklist, manutenção, montagem, manutenções feitas).
--   * A Análise (repair_dashboard_reprovados) passa a ler esse histórico, em vez das reprovações da quarentena.

create table if not exists public.reprovados_log (
  id uuid primary key default gen_random_uuid(),
  serial text not null check (char_length(btrim(serial)) between 1 and 100),
  serial_key text generated always as (lower(btrim(serial))) stored,
  os_number text,
  responsavel text,
  desmontagem text,
  checklist text,
  manutencao text,
  montagem text,
  feitas text,
  feitas_qtd integer,
  registered_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

create index if not exists reprovados_log_serial_idx on public.reprovados_log (serial_key, created_at);
create index if not exists reprovados_log_created_idx on public.reprovados_log (created_at desc);

alter table public.reprovados_log enable row level security;
revoke all on public.reprovados_log from anon, authenticated;

-- Grava a consulta da aba Reprovados. Devolve quantos seriais foram registrados.
create or replace function public.reprovados_register(p_serials text[]) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not (select public.has_any_role(array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  insert into public.reprovados_log (serial, os_number, responsavel, desmontagem, checklist, manutencao, montagem, feitas, feitas_qtd, registered_by)
  select l.serial, l.os_number, l.responsavel, l.desmontagem, l.checklist, l.manutencao, l.montagem, l.feitas, l.feitas_qtd, (select auth.uid())
    from public.reprovados_lookup(p_serials) l;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.reprovados_register(text[]) from public, anon;
grant execute on function public.reprovados_register(text[]) to authenticated;

-- Análise (admin e supervisor): um aparelho por linha, com o último registro dentro do período.
create or replace function public.repair_dashboard_reprovados(p_from date, p_to date)
returns table (
  serial text, os_number text, model text, reprovado_em timestamptz, reprovado_por text, vezes integer,
  responsavel text, desmontagem text, checklist text, manutencao text, montagem text, feitas text, feitas_qtd integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select (p_from::timestamp at time zone 'America/Sao_Paulo') as t0,
           ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo') as t1
  ),
  rp as (
    select distinct on (g.serial_key) g.*, count(*) over (partition by g.serial_key)::int as vezes
      from public.reprovados_log g, w
     where g.created_at >= w.t0 and g.created_at < w.t1
     order by g.serial_key, g.created_at desc
  )
  select r.serial, r.os_number, a.model, r.created_at,
         (select coalesce(nullif(btrim(p.name), ''), p.email) from public.profiles p where p.id = r.registered_by),
         r.vezes, r.responsavel, r.desmontagem, r.checklist, r.manutencao, r.montagem, r.feitas, r.feitas_qtd
    from rp r
    left join public.assets a on a.serial_key = r.serial_key
   where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
   order by r.created_at desc
   limit 500;
$$;

revoke all on function public.repair_dashboard_reprovados(date, date) from public, anon;
grant execute on function public.repair_dashboard_reprovados(date, date) to authenticated;
