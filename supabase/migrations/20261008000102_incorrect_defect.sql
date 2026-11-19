-- Aba "Defeito incorreto": quem bipa um ativo e marca a(s) peça(s) cujo defeito não foi identificado/relatado.
-- Rode depois de 20261008000101_glass_return_unlock.sql. Pode rodar de novo.
--
--   * Todos que têm função podem registrar (a mesma regra da Quarentena).
--   * Cada peça marcada vira um registro (serial, peça, quem identificou, quando). O ativo conta uma vez na Análise.
--   * A Análise (admin e supervisor) lê a lista; cada pessoa vê só os registros dela de hoje na própria aba.

create table if not exists public.incorrect_defects (
  id uuid primary key default gen_random_uuid(),
  serial text not null check (char_length(btrim(serial)) between 1 and 100),
  serial_key text generated always as (lower(btrim(serial))) stored,
  os_id uuid references public.service_orders (id) on delete set null,
  part text not null check (char_length(btrim(part)) between 1 and 80),
  note text check (note is null or char_length(note) <= 500),
  reported_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

create index if not exists incorrect_defects_serial_idx on public.incorrect_defects (serial_key, created_at);
create index if not exists incorrect_defects_created_idx on public.incorrect_defects (created_at desc);

alter table public.incorrect_defects enable row level security;
revoke all on public.incorrect_defects from anon, authenticated;

-- Registra as peças de um ativo (uma linha por peça). Devolve quantas foram registradas.
create or replace function public.register_incorrect_defect(p_serial text, p_parts text[], p_note text default null) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_serial text := btrim(coalesce(p_serial, ''));
  v_os uuid;
  v_part text;
  v_count integer := 0;
begin
  if not (select public.has_any_role(array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_serial = '' or p_parts is null or cardinality(p_parts) = 0 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;

  select id into v_os from public.service_orders where serial_key = lower(v_serial) order by created_at desc limit 1;

  for v_part in select distinct btrim(x) from unnest(p_parts) x where btrim(coalesce(x, '')) <> '' loop
    insert into public.incorrect_defects (serial, os_id, part, note, reported_by)
    values (v_serial, v_os, v_part, nullif(btrim(coalesce(p_note, '')), ''), (select auth.uid()));
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  return v_count;
end;
$$;

revoke all on function public.register_incorrect_defect(text, text[], text) from public, anon;
grant execute on function public.register_incorrect_defect(text, text[], text) to authenticated;

-- Os registros de hoje (Brasília) de quem está logado, para a própria aba.
create or replace function public.my_incorrect_defects_today()
returns table (serial text, part text, note text, at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select d.serial, d.part, d.note, d.created_at
    from public.incorrect_defects d
   where d.reported_by = (select auth.uid())
     and d.created_at >= (((now() at time zone 'America/Sao_Paulo')::date)::timestamp at time zone 'America/Sao_Paulo')
   order by d.created_at desc
   limit 500;
$$;

revoke all on function public.my_incorrect_defects_today() from public, anon;
grant execute on function public.my_incorrect_defects_today() to authenticated;

-- Análise (admin e supervisor): cada peça de defeito não identificado, com o técnico que identificou.
create or replace function public.repair_incorrect_defects(p_from date, p_to date)
returns table (serial text, os_number text, model text, part text, note text, technician text, at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select d.serial, o.os_number, a.model, d.part, d.note,
         coalesce(nullif(btrim(p.name), ''), p.email), d.created_at
    from public.incorrect_defects d
    left join public.service_orders o on o.id = d.os_id
    left join public.assets a on a.serial_key = d.serial_key
    left join public.profiles p on p.id = d.reported_by
   where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
     and d.created_at >= (p_from::timestamp at time zone 'America/Sao_Paulo')
     and d.created_at < ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo')
   order by d.created_at desc
   limit 2000;
$$;

revoke all on function public.repair_incorrect_defects(date, date) from public, anon;
grant execute on function public.repair_incorrect_defects(date, date) to authenticated;
