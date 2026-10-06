-- Ativos (planilha de seriais e unit ids), importados por admins via CSV.

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  -- Ex.: "iPhone 14 128GB-2386" = modelo + "-" + código do ativo.
  asset_short_id text not null check (btrim(asset_short_id) <> '' and char_length(asset_short_id) <= 200),
  serial text not null check (btrim(serial) <> '' and char_length(serial) <= 100),
  -- Derivados do asset_short_id, separando no último hífen.
  model text generated always as (
    case when position('-' in asset_short_id) > 0
      then regexp_replace(asset_short_id, '-[^-]*$', '')
      else asset_short_id end
  ) stored,
  unit_code text generated always as (
    case when position('-' in asset_short_id) > 0
      then substring(asset_short_id from '[^-]*$')
      else '' end
  ) stored,
  -- Chave de busca: o bipe vem com caixa e espaços diferentes da planilha.
  serial_key text generated always as (lower(btrim(serial))) stored,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  constraint assets_serial_key_key unique (serial_key),
  constraint assets_asset_short_id_key unique (asset_short_id)
);

comment on table public.assets is 'Ativos: asset_short_id (modelo + unit id) e serial.';

alter table public.assets enable row level security;
revoke all on public.assets from anon, authenticated;
grant select, insert on public.assets to authenticated;

-- Todo usuário logado consulta (o checklist busca pelo serial); só admin cadastra. Sem update nem delete.
create policy "assets_select" on public.assets
  for select to authenticated using (true);

create policy "assets_admin_insert" on public.assets
  for insert to authenticated
  with check ((select public.current_user_role()) = 'admin');

-- Importação em lote: insere só o que ainda não existe e devolve um resumo.
-- SECURITY INVOKER: a policy acima é quem garante que só o admin consegue inserir.
create function public.import_assets(rows jsonb) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_valid int;
  v_inserted int;
  v_conflicts int;
begin
  if jsonb_typeof(rows) is distinct from 'array' then
    raise exception 'rows deve ser uma lista';
  end if;

  with input as (
      select distinct on (lower(btrim(r.serial)))
        btrim(r.asset_short_id) as asset_short_id,
        btrim(r.serial) as serial
      from jsonb_to_recordset(rows) as r(asset_short_id text, serial text)
      where btrim(coalesce(r.asset_short_id, '')) <> '' and btrim(coalesce(r.serial, '')) <> ''
      order by lower(btrim(r.serial))
  )
  select count(*) into v_valid from input;

  with input as (
      select distinct on (lower(btrim(r.serial)))
        btrim(r.asset_short_id) as asset_short_id,
        btrim(r.serial) as serial
      from jsonb_to_recordset(rows) as r(asset_short_id text, serial text)
      where btrim(coalesce(r.asset_short_id, '')) <> '' and btrim(coalesce(r.serial, '')) <> ''
      order by lower(btrim(r.serial))
  ), ins as (
    insert into public.assets (asset_short_id, serial)
    select asset_short_id, serial from input
    on conflict do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  -- Conflito: o serial (ou o asset_short_id) já existe, mas ligado a outro par.
  with input as (
      select distinct on (lower(btrim(r.serial)))
        btrim(r.asset_short_id) as asset_short_id,
        btrim(r.serial) as serial
      from jsonb_to_recordset(rows) as r(asset_short_id text, serial text)
      where btrim(coalesce(r.asset_short_id, '')) <> '' and btrim(coalesce(r.serial, '')) <> ''
      order by lower(btrim(r.serial))
  )
  select count(*) into v_conflicts
  from input i
  where exists (
      select 1 from public.assets a
      where a.serial_key = lower(i.serial) and a.asset_short_id <> i.asset_short_id
    )
    or exists (
      select 1 from public.assets a
      where a.asset_short_id = i.asset_short_id and a.serial_key <> lower(i.serial)
    );

  return jsonb_build_object(
    'valid', v_valid,
    'inserted', v_inserted,
    'conflicts', v_conflicts,
    'existing', v_valid - v_inserted - v_conflicts
  );
end;
$$;

revoke all on function public.import_assets(jsonb) from public, anon;
grant execute on function public.import_assets(jsonb) to authenticated;

-- O checklist guarda de qual ativo é o aparelho.
alter table public.devices add column asset_short_id text check (char_length(asset_short_id) <= 200);
