-- Quarentena: o destino "laudo" da montagem vira "quarentena", e nasce a aba Quarentena,
-- onde montadores e admins bipam seriais e marcam cada um como aprovado ou reprovado.
-- Rode depois de 20261008000014_assembly_reject.sql. Pode rodar de novo.

alter table public.devices drop constraint if exists devices_destination_check;
update public.devices set destination = 'quarentena' where destination = 'laudo';
alter table public.devices
  add constraint devices_destination_check
  check (destination in ('montagem', 'vidro', 'analise', 'bloqueio', 'quarentena', 'manutencao'));

create table if not exists public.quarantine_checks (
  id uuid primary key default gen_random_uuid(),
  serial text not null check (char_length(btrim(serial)) between 1 and 100),
  asset_short_id text,
  result text not null check (result in ('aprovado', 'reprovado')),
  user_id uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

create index if not exists quarantine_checks_created_idx on public.quarantine_checks (created_at desc);

alter table public.quarantine_checks enable row level security;

drop policy if exists "quarantine_insert" on public.quarantine_checks;
create policy "quarantine_insert" on public.quarantine_checks
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.current_user_role()) in ('montador', 'admin')
  );

-- Cada um vê os seus; admin e supervisor veem todos.
drop policy if exists "quarantine_select" on public.quarantine_checks;
create policy "quarantine_select" on public.quarantine_checks
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.current_user_role()) in ('admin', 'supervisor')
  );

-- Montagem: laudo vira quarentena, acrescenta o retorno para análise e os números da quarentena.
create or replace function public.assembly_report(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_user uuid default null
) returns jsonb
language sql
stable
set search_path = ''
as $$
  with base as (
    select d.id, lower(btrim(d.serial)) as serial_key, d.serial, d.status, d.faulty_parts, d.failed_items,
           d.asset_short_id, d.source_device_id, d.user_id, d.concluded_at, d.destination, d.notes
    from public.devices d
    where d.kind = 'montagem'
      and d.phase = 'concluido'
      and (p_from is null or d.concluded_at >= p_from)
      and (p_to is null or d.concluded_at < p_to)
      and (p_user is null or d.user_id = p_user)
  ),
  quarantine as (
    select q.result
    from public.quarantine_checks q
    where (p_from is null or q.created_at >= p_from)
      and (p_to is null or q.created_at < p_to)
      and (p_user is null or q.user_id = p_user)
  ),
  parts as (
    select b.id, f ->> 'item' as part
    from base b, jsonb_array_elements(b.faulty_parts) as f
    where b.status = 'reprovado'
  )
  select jsonb_build_object(
    'checklists', (select count(*) from base),
    'released', (select count(distinct serial_key) from base where status = 'liberado'),
    'released_block', (select count(distinct serial_key) from base where status = 'liberado' and destination = 'bloqueio'),
    'released_quarantine', (select count(distinct serial_key) from base where status = 'liberado' and destination = 'quarentena'),
    'rejected', (select count(*) from base where status = 'reprovado'),
    'returned_maintenance', (select count(distinct serial_key) from base
                              where status = 'reprovado' and destination = 'manutencao'),
    'returned_analysis', (select count(distinct serial_key) from base
                           where status = 'reprovado' and destination = 'analise'),
    'quarantine_approved', (select count(*) from quarantine where result = 'aprovado'),
    'quarantine_rejected', (select count(*) from quarantine where result = 'reprovado'),
    'by_assembler', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'released', released, 'rejected', rejected)
                       order by released desc, rejected desc, name)
      from (
        select coalesce(nullif(btrim(p.name), ''), p.email) as name,
               count(distinct b.serial_key) filter (where b.status = 'liberado') as released,
               count(*) filter (where b.status = 'reprovado') as rejected
        from base b
        join public.profiles p on p.id = b.user_id
        group by 1
      ) t
    ), '[]'::jsonb),
    'by_part', coalesce((
      select jsonb_agg(jsonb_build_object('part', part, 'count', n) order by n desc, part)
      from (select part, count(*) as n from parts group by part) t
    ), '[]'::jsonb),
    'rejections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'unit', r.asset_short_id,
        'serial', r.serial,
        'technician', r.technician,
        'assembler', r.assembler,
        'reasons', to_jsonb(r.failed_items),
        'parts', r.parts,
        'destination', r.destination,
        'note', r.notes
      ) order by r.concluded_at desc)
      from (
        select b.asset_short_id, b.serial, b.failed_items, b.concluded_at, b.destination, b.notes,
               coalesce(nullif(btrim(pa.name), ''), pa.email) as assembler,
               coalesce(nullif(btrim(pt.name), ''), pt.email) as technician,
               coalesce((select jsonb_agg(f ->> 'item') from jsonb_array_elements(b.faulty_parts) as f), '[]'::jsonb) as parts
        from base b
        join public.profiles pa on pa.id = b.user_id
        left join public.devices src on src.id = b.source_device_id
        left join public.profiles pt on pt.id = src.user_id
        where b.status = 'reprovado'
        order by b.concluded_at desc
        limit 200
      ) r
    ), '[]'::jsonb)
  );
$$;
