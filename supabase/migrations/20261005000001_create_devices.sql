-- Aparelhos testados e o resultado de cada item do checklist.
create type public.device_status as enum ('incompleto', 'liberado', 'reprovado');

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  model text not null default '' check (char_length(model) <= 100),
  serial text not null default '' check (char_length(serial) <= 64),
  technician text not null default '' check (char_length(technician) <= 100),
  -- { "<item_id>": "ok" | "fail" | "" }; o catálogo de itens vive no código.
  results jsonb not null default '{}'::jsonb
    check (jsonb_typeof(results) = 'object')
    check (not jsonb_path_exists(results, '$.* ? (@ != "ok" && @ != "fail" && @ != "")')),
  -- Desnormalizados a partir de results, para listar e filtrar sem recalcular.
  status public.device_status not null default 'incompleto',
  tested_count smallint not null default 0 check (tested_count >= 0),
  failed_items text[] not null default '{}' check (cardinality(failed_items) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.devices is 'Checklist de testes por aparelho iPhone.';

create index devices_updated_at_idx on public.devices (updated_at desc);
create index devices_serial_idx on public.devices (lower(btrim(serial))) where serial <> '';

-- updated_at sempre vem do servidor.
create function public.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger devices_set_updated_at
before update on public.devices
for each row execute function public.set_updated_at();

-- Acesso público (sem login): ler, criar e editar; nunca apagar.
alter table public.devices enable row level security;

create policy "devices_public_select" on public.devices
  for select to anon, authenticated using (true);
create policy "devices_public_insert" on public.devices
  for insert to anon, authenticated with check (true);
create policy "devices_public_update" on public.devices
  for update to anon, authenticated using (true) with check (true);

revoke delete, truncate, references, trigger on public.devices from anon, authenticated;
-- Sem efeito enquanto UPDATE é concedido na tabela toda; ver a migration seguinte.
revoke update (created_at) on public.devices from anon, authenticated;

alter publication supabase_realtime add table public.devices;
