-- Dia Laboratório: o supervisor entrega os ativos aos técnicos (um balão por ativo), o técnico faz o checklist de
-- manutenção a partir dos balões e o supervisor acompanha o que entrou, o que saiu e onde está cada ativo.
-- Rode depois de 20261008000107_glass_flag_repair.sql. Pode rodar de novo.
--
--   * lab_assets: uma linha por passagem do ativo pelo laboratório (onde ele está agora).
--   * lab_balloons: os balões. Um ativo só tem um balão aberto (ou transferência pendente) por vez.
--   * lab_events: o histórico de todo movimento (entrega, vidro, transferência, confirmação, finalização,
--     quarentena, redistribuição).
--
-- Regras:
--   * O Checklist manutenção só abre pelos balões (start_legacy_maintenance exige o balão; o admin fica liberado).
--     A migration 110 tirou essa trava. Checklists começados antes desta aba não viram balões.
--   * Finalizar o checklist (qualquer destino) fecha o balão: abate 1 da meta do técnico.
--   * Transferir fecha o balão de quem transfere (conta como finalizado) e cria um balão pendente para quem recebe;
--     só depois da confirmação ele pode ser trabalhado e entra na meta.
--   * Vidro: o ativo fica em "Vidro" até o supervisor ou o técnico de vidro direcionar para um técnico.
--   * Quarentena: aprovado sai do laboratório; reprovado fica aguardando o supervisor redistribuir.
--   * Saída do laboratório (meta de saída): PT e quarentena aprovada. Revenda e bloqueado saem, mas não contam.

-- 1) Tabelas ---------------------------------------------------------------------------------------------------------
create table if not exists public.lab_assets (
  id uuid primary key default gen_random_uuid(),
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  unit_id text,
  model text,
  status text not null default 'aguardando_manutencao',
  -- Com quem está o balão (aberto ou transferência pendente).
  technician_id uuid references public.profiles (id),
  -- O último técnico que finalizou um balão deste ativo.
  last_technician_id uuid references public.profiles (id),
  entered_by uuid references public.profiles (id),
  entered_at timestamptz not null default now(),
  exited_at timestamptz,
  rejected_at timestamptz,
  last_move_at timestamptz not null default now()
);

alter table public.lab_assets drop constraint if exists lab_assets_status_check;
alter table public.lab_assets add constraint lab_assets_status_check check (status in (
  'aguardando_manutencao', 'transferencia_pendente', 'vidro', 'analise', 'quarentena', 'reprovado_aguardando',
  'quarentena_aprovada', 'pt', 'revenda', 'bloqueado'));

-- Uma passagem aberta por ativo.
create unique index if not exists lab_assets_open_idx on public.lab_assets (serial_key) where exited_at is null;
create index if not exists lab_assets_status_idx on public.lab_assets (status);
create index if not exists lab_assets_moves_idx on public.lab_assets (last_move_at desc);

create table if not exists public.lab_balloons (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.lab_assets (id) on delete cascade,
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  technician_id uuid not null references public.profiles (id),
  status text not null default 'aberto',
  source text not null,
  -- Quem entregou, direcionou ou transferiu.
  from_id uuid references public.profiles (id),
  note text,
  stage_id uuid references public.repair_stages (id) on delete set null,
  outcome text,
  transferred_to uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  -- Quando passou a contar para o técnico (na transferência, a confirmação do recebimento).
  confirmed_at timestamptz,
  finished_at timestamptz
);

alter table public.lab_balloons drop constraint if exists lab_balloons_status_check;
alter table public.lab_balloons add constraint lab_balloons_status_check
  check (status in ('pendente', 'aberto', 'finalizado', 'transferido'));
alter table public.lab_balloons drop constraint if exists lab_balloons_source_check;
alter table public.lab_balloons add constraint lab_balloons_source_check
  check (source in ('entrega', 'vidro', 'redistribuicao', 'transferencia', 'retorno'));

-- Um técnico por vez: um balão aberto (ou pendente) por ativo.
create unique index if not exists lab_balloons_open_idx on public.lab_balloons (serial_key) where status in ('pendente', 'aberto');
create index if not exists lab_balloons_tech_idx on public.lab_balloons (technician_id, status);
create index if not exists lab_balloons_stage_idx on public.lab_balloons (stage_id);
create index if not exists lab_balloons_finished_idx on public.lab_balloons (finished_at);

create table if not exists public.lab_events (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references public.lab_assets (id) on delete cascade,
  balloon_id uuid references public.lab_balloons (id) on delete set null,
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  kind text not null,
  actor_id uuid references public.profiles (id),
  from_id uuid references public.profiles (id),
  to_id uuid references public.profiles (id),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Ordem estável dos eventos gravados no mesmo instante (mesma transação).
alter table public.lab_events add column if not exists seq bigint generated always as identity;
create index if not exists lab_events_serial_idx on public.lab_events (serial_key, created_at desc);

-- Ninguém lê nem grava direto: tudo passa pelas funções abaixo (que conferem o papel).
alter table public.lab_assets enable row level security;
alter table public.lab_balloons enable row level security;
alter table public.lab_events enable row level security;
revoke all on public.lab_assets, public.lab_balloons, public.lab_events from anon, authenticated;

-- 2) Funções internas ------------------------------------------------------------------------------------------------
create or replace function public.lab_is_technician(p_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles p
                  where p.id = p_id and (p.role in ('tecnico', 'admin') or p.extra_roles && array['tecnico', 'admin']::public.user_role[]));
$$;

create or replace function public.lab_name(p_id uuid) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.name), ''), p.email) from public.profiles p where p.id = p_id;
$$;

create or replace function public.lab_log(p_asset uuid, p_balloon uuid, p_serial text, p_kind text,
                                          p_from uuid default null, p_to uuid default null, p_detail jsonb default '{}')
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.lab_events (asset_id, balloon_id, serial, kind, actor_id, from_id, to_id, detail)
  values (p_asset, p_balloon, p_serial, p_kind, (select auth.uid()), p_from, p_to, coalesce(p_detail, '{}'::jsonb));
$$;

-- A passagem aberta do ativo; sem ela, abre uma nova (com o Unit ID e o modelo da planilha de ativos).
create or replace function public.lab_open_passage(p_serial text) returns public.lab_assets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.lab_assets;
  v_key text := lower(btrim(coalesce(p_serial, '')));
begin
  select * into v from public.lab_assets where serial_key = v_key and exited_at is null for update;
  if found then
    return v;
  end if;
  insert into public.lab_assets (serial, unit_id, model, entered_by)
  select btrim(p_serial), a.asset_short_id, a.model, (select auth.uid())
    from (select 1) one
    left join lateral (select x.asset_short_id, x.model from public.assets x where x.serial_key = v_key limit 1) a on true
  returning * into v;
  perform public.lab_log(v.id, null, v.serial, 'entrada');
  return v;
end;
$$;

-- Cria o balão (aberto ou pendente) e põe o ativo com o técnico.
create or replace function public.lab_give(p_asset public.lab_assets, p_technician uuid, p_source text, p_from uuid,
                                           p_note text default null, p_pending boolean default false,
                                           p_stage uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.lab_balloons (asset_id, serial, technician_id, status, source, from_id, note, stage_id, confirmed_at)
  values (p_asset.id, p_asset.serial, p_technician, case when p_pending then 'pendente' else 'aberto' end, p_source,
          p_from, nullif(btrim(coalesce(p_note, '')), ''), p_stage, case when p_pending then null else now() end)
  returning id into v_id;
  update public.lab_assets
     set status = case when p_pending then 'transferencia_pendente' else 'aguardando_manutencao' end,
         technician_id = p_technician, last_move_at = now()
   where id = p_asset.id;
  return v_id;
end;
$$;

-- Fecha o serviço de vidro aberto do ativo (o técnico de vidro ou o supervisor direcionou para um técnico).
create or replace function public.lab_close_glass(p_serial text, p_display boolean) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.repair_glass_jobs;
begin
  select g.* into j
    from public.repair_glass_jobs g
   where g.serial_key = lower(btrim(p_serial)) and g.status <> 'concluido'
   order by g.created_at desc
   limit 1
   for update;
  if not found then
    return null;
  end if;
  update public.repair_glass_jobs
     set status = 'concluido', finished_by = (select auth.uid()), finished_at = now(),
         display_requested = coalesce(p_display, false)
   where id = j.id;
  perform public.repair_log(j.os_id, j.stage_id, null, 'vidro_direcionado',
    jsonb_build_object('status_anterior', j.status, 'display_solicitado', coalesce(p_display, false)));
  return jsonb_build_object('servico_vidro', j.id, 'status_anterior', j.status);
end;
$$;

-- Destino do checklist -> onde o ativo fica.
create or replace function public.lab_status_for(p_outcome text) returns text
language sql
immutable
set search_path = ''
as $$
  select case p_outcome
    when 'quarentena' then 'quarentena'
    when 'vidro' then 'vidro'
    when 'analise' then 'analise'
    when 'pt' then 'pt'
    when 'revenda' then 'revenda'
    when 'bloqueado' then 'bloqueado'
    else 'analise' end;
$$;

-- Janela do dia no horário de São Paulo.
create or replace function public.lab_day_start(p_day date) returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select p_day::timestamp at time zone 'America/Sao_Paulo';
$$;

revoke all on function public.lab_is_technician(uuid) from public, anon, authenticated;
revoke all on function public.lab_name(uuid) from public, anon, authenticated;
revoke all on function public.lab_log(uuid, uuid, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.lab_open_passage(text) from public, anon, authenticated;
revoke all on function public.lab_give(public.lab_assets, uuid, text, uuid, text, boolean, uuid) from public, anon, authenticated;
revoke all on function public.lab_close_glass(text, boolean) from public, anon, authenticated;

-- 3) Entrega de ativos (supervisor e admin) ---------------------------------------------------------------------------
-- Quem recebe balões: técnicos e admins (o admin abre qualquer checklist).
create or replace function public.lab_technicians() returns table (id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, coalesce(nullif(btrim(p.name), ''), p.email)
    from public.profiles p
   where (select public.has_any_role(array['admin', 'supervisor', 'tecnico', 'tecnico_vidro']::public.user_role[]))
     and (p.role in ('tecnico', 'admin') or p.extra_roles && array['tecnico', 'admin']::public.user_role[])
   order by 2;
$$;

revoke all on function public.lab_technicians() from public, anon;
grant execute on function public.lab_technicians() to authenticated;

-- Prévia dos seriais bipados: Unit ID, onde o ativo está e com quem (ativo ainda aberto).
create or replace function public.lab_preview(p_serials text[])
returns table (serial text, found boolean, unit text, model text, lab_status text, holder text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_any_role(array['admin', 'supervisor', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return query
    select s.v, a.serial_key is not null, a.asset_short_id, a.model, la.status,
           (select public.lab_name(b.technician_id)
              from public.lab_balloons b where b.serial_key = lower(btrim(s.v)) and b.status in ('pendente', 'aberto'))
      from unnest(coalesce(p_serials, '{}')) with ordinality s(v, ord)
      left join lateral (select x.serial_key, x.asset_short_id, x.model from public.assets x
                          where x.serial_key = lower(btrim(s.v)) limit 1) a on true
      left join public.lab_assets la on la.serial_key = lower(btrim(s.v)) and la.exited_at is null
     order by s.ord;
end;
$$;

revoke all on function public.lab_preview(text[]) from public, anon;
grant execute on function public.lab_preview(text[]) to authenticated;

-- Vincular: um balão para cada serial com o técnico escolhido. Tudo ou nada (serial inválido: erro com o serial).
-- O ativo que está no Vidro é direcionado; o reprovado na quarentena é redistribuído.
create or replace function public.lab_deliver(p_serials text[], p_technician uuid) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_serial text;
  v_asset public.lab_assets;
  v_balloon uuid;
  v_source text;
  v_glass jsonb;
  v_count integer := 0;
begin
  if not (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if not public.lab_is_technician(p_technician) then
    raise exception 'lab_technician_invalid' using errcode = 'P0001';
  end if;
  if coalesce(array_length(p_serials, 1), 0) = 0 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;

  for v_serial in
    select min(btrim(s)) from unnest(p_serials) s where btrim(coalesce(s, '')) <> '' group by lower(btrim(s))
  loop
    if not exists (select 1 from public.assets a where a.serial_key = lower(v_serial)) then
      raise exception 'lab_serial_not_found' using errcode = 'P0001', detail = v_serial;
    end if;
    if exists (select 1 from public.lab_balloons b where b.serial_key = lower(v_serial) and b.status in ('pendente', 'aberto')) then
      raise exception 'lab_serial_taken' using errcode = 'P0001', detail = v_serial;
    end if;

    v_asset := public.lab_open_passage(v_serial);
    v_glass := null;
    v_source := case v_asset.status when 'vidro' then 'vidro' when 'reprovado_aguardando' then 'redistribuicao' else 'entrega' end;
    if v_source = 'vidro' then
      v_glass := public.lab_close_glass(v_serial, false);
    end if;
    v_balloon := public.lab_give(v_asset, p_technician, v_source, v_me);
    perform public.lab_log(v_asset.id, v_balloon, v_asset.serial,
      case v_source when 'vidro' then 'direcionamento_vidro' when 'redistribuicao' then 'redistribuicao' else 'entrega' end,
      v_me, p_technician, jsonb_build_object('status_anterior', v_asset.status, 'vidro', v_glass, 'por', 'supervisor'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.lab_deliver(text[], uuid) from public, anon;
grant execute on function public.lab_deliver(text[], uuid) to authenticated;

-- 4) Direcionar do Vidro (supervisor, admin e técnico de vidro) -------------------------------------------------------
-- Só ativos com status Vidro. Fecha o serviço de vidro aberto e cria o balão para o técnico.
create or replace function public.lab_direct_from_glass(p_serials text[], p_technician uuid, p_display boolean default false)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_serial text;
  v_asset public.lab_assets;
  v_balloon uuid;
  v_glass jsonb;
  v_count integer := 0;
  v_by text;
begin
  if not (select public.has_any_role(array['admin', 'supervisor', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if not public.lab_is_technician(p_technician) then
    raise exception 'lab_technician_invalid' using errcode = 'P0001';
  end if;
  if coalesce(array_length(p_serials, 1), 0) = 0 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  v_by := case when (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then 'supervisor' else 'tecnico_vidro' end;

  for v_serial in
    select min(btrim(s)) from unnest(p_serials) s where btrim(coalesce(s, '')) <> '' group by lower(btrim(s))
  loop
    select * into v_asset from public.lab_assets where serial_key = lower(v_serial) and exited_at is null for update;
    if not found or v_asset.status <> 'vidro' then
      raise exception 'lab_not_in_glass' using errcode = 'P0001', detail = v_serial;
    end if;
    v_glass := public.lab_close_glass(v_serial, p_display);
    v_balloon := public.lab_give(v_asset, p_technician, 'vidro', v_me,
      case when coalesce(p_display, false) then 'Troca de display solicitada pelo técnico de vidro.' end);
    perform public.lab_log(v_asset.id, v_balloon, v_asset.serial, 'direcionamento_vidro', v_me, p_technician,
      jsonb_build_object('por', v_by, 'vidro', v_glass, 'display_solicitado', coalesce(p_display, false)));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.lab_direct_from_glass(text[], uuid, boolean) from public, anon;
grant execute on function public.lab_direct_from_glass(text[], uuid, boolean) to authenticated;

-- Seriais com status Vidro (a aba Vidro mostra "Direcionar para técnico" neles).
create or replace function public.lab_glass_serials() returns table (serial text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.serial from public.lab_assets a
   where a.status = 'vidro' and a.exited_at is null
     and (select public.has_any_role(array['admin', 'supervisor', 'tecnico_vidro']::public.user_role[]));
$$;

revoke all on function public.lab_glass_serials() from public, anon;
grant execute on function public.lab_glass_serials() to authenticated;

-- 5) Reprovados na quarentena (supervisor e admin) --------------------------------------------------------------------
create or replace function public.lab_rejected()
returns table (asset_id uuid, serial text, unit text, model text, last_technician text, rejected_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return query
    select a.id, a.serial, a.unit_id, a.model, public.lab_name(a.last_technician_id), a.rejected_at
      from public.lab_assets a
     where a.status = 'reprovado_aguardando' and a.exited_at is null
     order by a.rejected_at nulls last, a.serial;
end;
$$;

revoke all on function public.lab_rejected() from public, anon;
grant execute on function public.lab_rejected() to authenticated;

create or replace function public.lab_redistribute(p_assets uuid[], p_technician uuid) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_id uuid;
  v_asset public.lab_assets;
  v_balloon uuid;
  v_count integer := 0;
begin
  if not (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if not public.lab_is_technician(p_technician) then
    raise exception 'lab_technician_invalid' using errcode = 'P0001';
  end if;
  if coalesce(array_length(p_assets, 1), 0) = 0 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  foreach v_id in array p_assets loop
    select * into v_asset from public.lab_assets where id = v_id for update;
    if not found or v_asset.status <> 'reprovado_aguardando' or v_asset.exited_at is not null then
      raise exception 'lab_not_rejected' using errcode = 'P0001', detail = coalesce(v_asset.serial, v_id::text);
    end if;
    v_balloon := public.lab_give(v_asset, p_technician, 'redistribuicao', v_me);
    perform public.lab_log(v_asset.id, v_balloon, v_asset.serial, 'redistribuicao', v_me, p_technician,
      jsonb_build_object('ultimo_tecnico', v_asset.last_technician_id, 'reprovado_em', v_asset.rejected_at));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.lab_redistribute(uuid[], uuid) from public, anon;
grant execute on function public.lab_redistribute(uuid[], uuid) to authenticated;

-- 6) Técnico: balões, transferência e confirmação ---------------------------------------------------------------------
create or replace function public.lab_my_balloons()
returns table (id uuid, serial text, unit text, model text, status text, source text, from_name text, note text,
               created_at timestamptz, confirmed_at timestamptz, stage_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.serial, a.unit_id, a.model, b.status, b.source, public.lab_name(b.from_id), b.note,
         b.created_at, b.confirmed_at, b.stage_id
    from public.lab_balloons b
    join public.lab_assets a on a.id = b.asset_id
   where b.technician_id = (select auth.uid()) and b.status in ('pendente', 'aberto')
   order by (b.status = 'pendente') desc, b.created_at;
$$;

revoke all on function public.lab_my_balloons() from public, anon;
grant execute on function public.lab_my_balloons() to authenticated;

-- Transferir (com o checklist em andamento ou não): conta como finalizado para quem transfere.
create or replace function public.lab_transfer(p_balloon uuid, p_technician uuid, p_note text default null) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  b public.lab_balloons;
  v_asset public.lab_assets;
  v_new uuid;
  v_marks jsonb;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into b from public.lab_balloons where id = p_balloon for update;
  if not found or b.status <> 'aberto'
     or (b.technician_id <> v_me and not (select public.has_any_role(array['admin']::public.user_role[]))) then
    raise exception 'lab_balloon_closed' using errcode = 'P0001';
  end if;
  if p_technician is null or p_technician = b.technician_id or not public.lab_is_technician(p_technician) then
    raise exception 'lab_technician_invalid' using errcode = 'P0001';
  end if;

  -- O que já foi preenchido fica no histórico.
  if b.stage_id is not null then
    select coalesce(jsonb_object_agg(r.phase, r.results), '{}'::jsonb) into v_marks
      from public.repair_checklist_results r where r.stage_id = b.stage_id;
  end if;

  update public.lab_balloons
     set status = 'transferido', outcome = 'transferido', finished_at = now(), transferred_to = p_technician
   where id = b.id;
  select * into v_asset from public.lab_assets where id = b.asset_id for update;
  v_new := public.lab_give(v_asset, p_technician, 'transferencia', b.technician_id, p_note, true, b.stage_id);
  update public.lab_assets set last_technician_id = b.technician_id where id = v_asset.id;
  perform public.lab_log(v_asset.id, v_new, v_asset.serial, 'transferencia', b.technician_id, p_technician,
    jsonb_build_object('balao_anterior', b.id, 'checklist', b.stage_id, 'marcacoes', v_marks,
                       'motivo', nullif(btrim(coalesce(p_note, '')), '')));
  return v_new;
end;
$$;

revoke all on function public.lab_transfer(uuid, uuid, text) from public, anon;
grant execute on function public.lab_transfer(uuid, uuid, text) to authenticated;

-- Confirmar o recebimento: o balão pode ser trabalhado e entra na meta de quem recebeu.
create or replace function public.lab_confirm_transfer(p_balloon uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  b public.lab_balloons;
begin
  select * into b from public.lab_balloons where id = p_balloon for update;
  if not found or b.status <> 'pendente' or b.technician_id <> v_me then
    raise exception 'lab_balloon_closed' using errcode = 'P0001';
  end if;
  update public.lab_balloons set status = 'aberto', confirmed_at = now() where id = b.id;
  update public.lab_assets set status = 'aguardando_manutencao', last_move_at = now() where id = b.asset_id;
  -- O checklist em andamento passa para quem recebeu, com as marcações.
  if b.stage_id is not null then
    update public.repair_stages
       set technician_id = v_me, handover_from = b.from_id, handover_at = now(),
           handover_note = coalesce(b.note, 'Transferido por ' || coalesce(public.lab_name(b.from_id), 'outro técnico') || '.')
     where id = b.stage_id and status = 'em_andamento';
  end if;
  perform public.lab_log(b.asset_id, b.id, b.serial, 'confirmacao', b.from_id, v_me,
    jsonb_build_object('enviado_em', b.created_at));
end;
$$;

revoke all on function public.lab_confirm_transfer(uuid) from public, anon;
grant execute on function public.lab_confirm_transfer(uuid) to authenticated;

-- 7) Meta do técnico ---------------------------------------------------------------------------------------------------
-- Finalizados no dia (transferidos contam) + balões que ficaram com ele no fim do dia (pendentes não contam).
create or replace function public.lab_goal_count(p_user uuid, p_day date) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with w as (select public.lab_day_start(p_day) as t0, public.lab_day_start(p_day + 1) as t1),
  c as (
    select count(*) filter (where b.status in ('finalizado', 'transferido') and b.finished_at >= w.t0 and b.finished_at < w.t1) as finalizados,
           count(*) filter (where b.status = 'transferido' and b.finished_at >= w.t0 and b.finished_at < w.t1) as transferidos,
           count(*) filter (where b.confirmed_at < w.t1 and (b.finished_at is null or b.finished_at >= w.t1)) as abertos
      from public.lab_balloons b, w
     where b.technician_id = p_user
  )
  select jsonb_build_object(
    'finalizados', c.finalizados, 'transferidos', c.transferidos, 'abertos', c.abertos,
    'meta', c.finalizados + c.abertos,
    'pendentes', (select count(*) from public.lab_balloons b where b.technician_id = p_user and b.status = 'pendente'))
  from c;
$$;

revoke all on function public.lab_goal_count(uuid, date) from public, anon, authenticated;

create or replace function public.lab_my_goal() returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with d as (select (now() at time zone 'America/Sao_Paulo')::date as day)
  select public.lab_goal_count((select auth.uid()), d.day)
         || jsonb_build_object('justificativa',
              (select n.note from public.repair_goal_notes n where n.user_id = (select auth.uid()) and n.day = d.day))
    from d
   where (select auth.uid()) is not null;
$$;

revoke all on function public.lab_my_goal() from public, anon;
grant execute on function public.lab_my_goal() to authenticated;

-- Análise > Produtividade individual: a meta dos balões de cada técnico no dia.
create or replace function public.lab_productivity(p_day date)
returns table (user_id uuid, finalizados integer, transferidos integer, abertos integer, meta integer)
language sql
stable
security definer
set search_path = ''
as $$
  select x.technician_id, (c.goal ->> 'finalizados')::integer, (c.goal ->> 'transferidos')::integer,
         (c.goal ->> 'abertos')::integer, (c.goal ->> 'meta')::integer
    from (select distinct b.technician_id from public.lab_balloons b) x
    cross join lateral (select public.lab_goal_count(x.technician_id, p_day) as goal) c
   where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
     and (c.goal ->> 'meta')::integer > 0;
$$;

revoke all on function public.lab_productivity(date) from public, anon;
grant execute on function public.lab_productivity(date) to authenticated;

-- 8) Acompanhamento (supervisor e admin) ------------------------------------------------------------------------------
-- Passagens abertas e as que entraram, saíram ou foram reprovadas no período.
-- A migration 115 muda o retorno (com a OS): para rodar de novo, apaga antes.
drop function if exists public.lab_board(timestamptz, timestamptz);
create or replace function public.lab_board(p_from timestamptz, p_to timestamptz)
returns table (id uuid, serial text, unit text, model text, status text, technician_id uuid, technician text,
               last_technician text, entered_at timestamptz, exited_at timestamptz, rejected_at timestamptz,
               last_move_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return query
    select a.id, a.serial, a.unit_id, a.model, a.status, a.technician_id, public.lab_name(a.technician_id),
           public.lab_name(a.last_technician_id), a.entered_at, a.exited_at, a.rejected_at, a.last_move_at
      from public.lab_assets a
     where a.exited_at is null
        or (a.entered_at >= p_from and a.entered_at < p_to)
        or (a.exited_at >= p_from and a.exited_at < p_to)
        or (a.rejected_at >= p_from and a.rejected_at < p_to)
     order by a.last_move_at desc
     limit 5000;
end;
$$;

revoke all on function public.lab_board(timestamptz, timestamptz) from public, anon;
grant execute on function public.lab_board(timestamptz, timestamptz) to authenticated;

-- Balões que estiveram abertos em algum momento do período (para a lista por técnico e os destinos).
-- A migration 115 muda o retorno (com a OS): para rodar de novo, apaga antes.
drop function if exists public.lab_balloon_report(timestamptz, timestamptz);
create or replace function public.lab_balloon_report(p_from timestamptz, p_to timestamptz)
returns table (id uuid, asset_id uuid, serial text, unit text, technician_id uuid, technician text, status text,
               source text, from_name text, transferred_to text, outcome text, created_at timestamptz,
               confirmed_at timestamptz, finished_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return query
    select b.id, b.asset_id, b.serial, a.unit_id, b.technician_id, public.lab_name(b.technician_id), b.status, b.source,
           public.lab_name(b.from_id), public.lab_name(b.transferred_to), b.outcome, b.created_at, b.confirmed_at,
           b.finished_at
      from public.lab_balloons b
      join public.lab_assets a on a.id = b.asset_id
     where b.created_at < p_to and (b.finished_at is null or b.finished_at >= p_from)
     order by b.created_at desc
     limit 5000;
end;
$$;

revoke all on function public.lab_balloon_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.lab_balloon_report(timestamptz, timestamptz) to authenticated;

-- Histórico do ativo no laboratório.
create or replace function public.lab_history(p_serial text)
returns table (kind text, actor text, from_name text, to_name text, detail jsonb, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return query
    select e.kind, public.lab_name(e.actor_id), public.lab_name(e.from_id), public.lab_name(e.to_id), e.detail, e.created_at
      from public.lab_events e
     where e.serial_key = lower(btrim(coalesce(p_serial, '')))
     order by e.created_at, e.seq;
end;
$$;

revoke all on function public.lab_history(text) from public, anon;
grant execute on function public.lab_history(text) to authenticated;

-- 9) Gatilhos: checklist, marcações e quarentena -----------------------------------------------------------------------
-- Checklist manutenção (legacy): aberto liga ao balão; finalizado fecha o balão e move o ativo para o destino.
create or replace function public.lab_on_stage() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.lab_balloons;
  v_asset public.lab_assets;
  v_status text;
  v_id uuid;
begin
  if new.stage <> 'manutencao' or not coalesce(new.legacy, false) then
    return null;
  end if;

  if new.status = 'em_andamento'
     and (tg_op = 'INSERT' or old.status is distinct from new.status or old.technician_id is distinct from new.technician_id) then
    select * into b from public.lab_balloons where serial_key = new.serial_key and status in ('pendente', 'aberto') for update;
    if found then
      if b.status = 'aberto' then
        if b.stage_id is distinct from new.id then
          update public.lab_balloons set stage_id = new.id where id = b.id;
        end if;
        -- O admin trocou o responsável (ou alguém assumiu o checklist): o balão vai junto.
        if b.technician_id <> new.technician_id then
          update public.lab_balloons set technician_id = new.technician_id, confirmed_at = now() where id = b.id;
          update public.lab_assets set technician_id = new.technician_id, last_move_at = now() where id = b.asset_id;
          perform public.lab_log(b.asset_id, b.id, b.serial, 'responsavel_trocado', b.technician_id, new.technician_id);
        end if;
      end if;
    else
      -- Voltou sem balão (PT recusado, retorno antigo do vidro, checklist começado antes desta aba): vira balão.
      -- PT recusado: a passagem que tinha saído como PT volta a ficar aberta (se não houver outra aberta).
      select a.* into v_asset from public.lab_assets a
       where a.serial_key = new.serial_key and a.status = 'pt' and a.exited_at is not null
         and exists (select 1 from public.lab_balloons x where x.asset_id = a.id and x.stage_id = new.id)
         and not exists (select 1 from public.lab_assets o where o.serial_key = new.serial_key and o.exited_at is null)
       order by a.entered_at desc limit 1 for update;
      if found then
        update public.lab_assets set exited_at = null where id = v_asset.id;
        perform public.lab_log(v_asset.id, null, v_asset.serial, 'pt_recusado');
      else
        v_asset := public.lab_open_passage(new.serial);
      end if;
      v_id := public.lab_give(v_asset, new.technician_id, 'retorno', null, null, false, new.id);
      perform public.lab_log(v_asset.id, v_id, v_asset.serial, 'retorno', null, new.technician_id,
        jsonb_build_object('status_anterior', v_asset.status));
    end if;

  elsif tg_op = 'UPDATE' and new.status = 'concluida' and old.status is distinct from 'concluida' then
    select * into b from public.lab_balloons where stage_id = new.id and status in ('pendente', 'aberto') for update;
    if found then
      if b.status = 'pendente' then
        raise exception 'lab_transfer_pending' using errcode = 'P0001';
      end if;
      v_status := public.lab_status_for(new.outcome);
      update public.lab_balloons set status = 'finalizado', outcome = new.outcome, finished_at = now() where id = b.id;
      update public.lab_assets
         set status = v_status, technician_id = null, last_technician_id = b.technician_id, last_move_at = now(),
             exited_at = case when v_status in ('pt', 'revenda', 'bloqueado') then now() end
       where id = b.asset_id;
      perform public.lab_log(b.asset_id, b.id, b.serial, 'finalizacao', b.technician_id, null,
        jsonb_build_object('destino', new.outcome, 'manutencoes', new.maintenance_items));
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists lab_on_stage on public.repair_stages;
create trigger lab_on_stage after insert or update of status, technician_id on public.repair_stages
  for each row execute function public.lab_on_stage();

-- Transferência pendente: ninguém marca o checklist até quem recebeu confirmar.
create or replace function public.lab_guard_checklist() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.lab_balloons b where b.stage_id = new.stage_id and b.status = 'pendente') then
    raise exception 'lab_transfer_pending' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists lab_guard_checklist on public.repair_checklist_results;
create trigger lab_guard_checklist before insert or update on public.repair_checklist_results
  for each row execute function public.lab_guard_checklist();

-- Resultado da quarentena (aba Quarentena, tabela quarantine_checks).
create or replace function public.lab_on_quarantine() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset public.lab_assets;
begin
  select * into v_asset from public.lab_assets
   where serial_key = lower(btrim(new.serial)) and exited_at is null and status in ('quarentena', 'analise')
   for update;
  if not found then
    return null;
  end if;
  if new.result = 'aprovado' then
    update public.lab_assets
       set status = 'quarentena_aprovada', exited_at = now(), technician_id = null, last_move_at = now()
     where id = v_asset.id;
    perform public.lab_log(v_asset.id, null, v_asset.serial, 'quarentena_aprovada', null, null,
      jsonb_build_object('registro', new.id, 'status_anterior', v_asset.status));
  elsif new.result = 'reprovado' then
    update public.lab_assets
       set status = 'reprovado_aguardando', rejected_at = now(), technician_id = null, last_move_at = now()
     where id = v_asset.id;
    perform public.lab_log(v_asset.id, null, v_asset.serial, 'quarentena_reprovada', null, null,
      jsonb_build_object('registro', new.id, 'status_anterior', v_asset.status));
  end if;
  return null;
end;
$$;

drop trigger if exists lab_on_quarantine on public.quarantine_checks;
create trigger lab_on_quarantine after insert on public.quarantine_checks
  for each row execute function public.lab_on_quarantine();

revoke all on function public.lab_on_stage() from public, anon, authenticated;
revoke all on function public.lab_guard_checklist() from public, anon, authenticated;
revoke all on function public.lab_on_quarantine() from public, anon, authenticated;

-- 10) Checklist manutenção só pelos balões (corpo da migration 88 + o balão) -----------------------------------------
create or replace function public.start_legacy_maintenance(p_serial text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_round integer;
  v_stage public.repair_stages;
  v_me uuid := (select auth.uid());
  v_admin boolean := (select public.has_any_role(array['admin']::public.user_role[]));
  v_balloon public.lab_balloons;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  -- O balão do ativo: o técnico só abre o checklist dos balões dele (o admin abre qualquer um).
  select * into v_balloon from public.lab_balloons
   where serial_key = lower(btrim(coalesce(p_serial, ''))) and status in ('pendente', 'aberto');
  if not v_admin then
    if not found or v_balloon.technician_id <> v_me then
      raise exception 'lab_no_balloon' using errcode = 'P0001',
        detail = coalesce(public.lab_name(v_balloon.technician_id), '');
    end if;
    if v_balloon.status = 'pendente' then
      raise exception 'lab_transfer_pending' using errcode = 'P0001';
    end if;
  elsif found and v_balloon.status = 'pendente' then
    raise exception 'lab_transfer_pending' using errcode = 'P0001';
  end if;

  v_os := public.current_os(p_serial);
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = v_os.id;

  if exists (select 1 from public.repair_stages
              where os_id = v_os.id and round = v_round and stage in ('desmontagem', 'avaliacao') and status <> 'concluida') then
    raise exception 'disassembly_open' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.repair_pt_requests where os_id = v_os.id and status = 'pendente') then
    raise exception 'pt_pending' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.repair_glass_jobs where os_id = v_os.id and status <> 'concluido') then
    raise exception 'in_glass' using errcode = 'P0001';
  end if;

  select * into v_stage from public.repair_stages where os_id = v_os.id and stage = 'manutencao' and round = v_round;
  if found then
    if v_stage.status <> 'concluida' then
      if not v_stage.legacy then
        raise exception 'in_repair' using errcode = 'P0001';
      end if;
      if v_stage.technician_id is distinct from v_me and not v_admin then
        raise exception 'legacy_other_owner' using errcode = 'P0001',
          detail = coalesce(public.lab_name(v_stage.technician_id), 'outro técnico');
      end if;
      return v_stage.id;
    end if;
    v_round := v_round + 1;
  end if;

  -- O checklist é de quem tem o balão (o admin, abrindo o balão de outro, abre para ele).
  insert into public.repair_stages (os_id, serial, stage, technician_id, round, legacy)
  values (v_os.id, v_os.serial, 'manutencao', coalesce(v_balloon.technician_id, v_me), v_round, true)
  returning * into v_stage;
  perform public.repair_log(v_os.id, v_stage.id, null, 'checklist_manutencao_iniciado');
  return v_stage.id;
end;
$$;

revoke all on function public.start_legacy_maintenance(text) from public, anon;
grant execute on function public.start_legacy_maintenance(text) to authenticated;

-- 11) Os checklists já começados antes desta aba NÃO viram balões: o Dia Laboratório começa do zero e só o supervisor
-- entrega os ativos (rodar esta migration de novo não cria balão nenhum).
