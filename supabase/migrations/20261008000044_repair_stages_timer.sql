-- MVP Reparo, banco 1/5: etapas do reparo por OS, cronômetro persistente e auditoria.
-- Rode depois de 20261008000043_os_by_technician.sql. Pode rodar de novo.
--
-- Modelo: a "passagem" do aparelho pelo laboratório é a OS (service_orders). Cada OS tem até duas etapas:
--   desmontagem (Estágio 1) e manutencao (Estágio 2, aberta automaticamente ao concluir o Estágio 1).
-- Todas as gravações passam por funções (security definer) que checam o papel; as tabelas só têm leitura direta.
-- Esta camada não altera as tabelas antigas (devices, part_requests, part_allocations, part_loans).

-- Linhas que ninguém pode alterar ou apagar (log de eventos e de movimentações).
create or replace function public.forbid_change() returns trigger
language plpgsql
as $$
begin
  raise exception 'registro imutável' using errcode = '42501';
end;
$$;

-- Etapas do reparo ------------------------------------------------------------------------------------------
create table if not exists public.repair_stages (
  id uuid primary key default gen_random_uuid(),
  os_id uuid not null references public.service_orders (id) on delete cascade,
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  stage text not null check (stage in ('desmontagem', 'manutencao')),
  status text not null default 'em_andamento' check (status in ('em_andamento', 'concluida')),
  technician_id uuid not null references public.profiles (id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- Só na manutenção: para onde o aparelho foi e os testes reprovados.
  outcome text check (outcome in ('quarentena', 'analise', 'revenda')),
  failed_tests jsonb not null default '[]'::jsonb,
  resale_reason text,
  unique (os_id, stage),
  constraint repair_stages_finished_chk check ((status = 'concluida') = (finished_at is not null)),
  constraint repair_stages_outcome_chk check (outcome is null or (stage = 'manutencao' and status = 'concluida')),
  constraint repair_stages_resale_chk
    check (outcome is distinct from 'revenda' or char_length(btrim(coalesce(resale_reason, ''))) >= 5)
);

create index if not exists repair_stages_serial_idx on public.repair_stages (serial_key, started_at desc);
create index if not exists repair_stages_open_idx on public.repair_stages (stage) where status = 'em_andamento';

-- Resultados dos checklists da etapa: um por fase (aparelho aberto ou fechado).
create table if not exists public.repair_checklist_results (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid not null references public.repair_stages (id) on delete cascade,
  phase text not null check (phase in ('aberto', 'fechado')),
  results jsonb not null default '{}'::jsonb,
  updated_by uuid not null default auth.uid() references public.profiles (id),
  updated_at timestamptz not null default now(),
  unique (stage_id, phase)
);

-- Cronômetro ------------------------------------------------------------------------------------------------
-- Uma única sessão aberta por etapa (índice abaixo): trocar de tipo fecha a anterior no mesmo instante,
-- então o tempo nunca é contado duas vezes.
create table if not exists public.repair_timer_sessions (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid not null references public.repair_stages (id) on delete cascade,
  kind text not null check (kind in ('produtivo', 'pausa', 'espera_peca')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  user_id uuid references public.profiles (id) default auth.uid(),
  constraint repair_timer_order_chk check (ended_at is null or ended_at >= started_at)
);

create unique index if not exists repair_timer_one_open_idx on public.repair_timer_sessions (stage_id) where ended_at is null;
create index if not exists repair_timer_stage_idx on public.repair_timer_sessions (stage_id, started_at);

-- Auditoria -------------------------------------------------------------------------------------------------
create table if not exists public.repair_events (
  id bigint generated always as identity primary key,
  os_id uuid references public.service_orders (id) on delete set null,
  stage_id uuid references public.repair_stages (id) on delete set null,
  request_id uuid,
  action text not null,
  actor uuid references public.profiles (id) default auth.uid(),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists repair_events_os_idx on public.repair_events (os_id, created_at);

-- Apagar uma OS (só o admin) limpa as etapas; o log fica, com os_id nulo. Por isso o trigger só barra
-- alteração dos campos de conteúdo, não o set null das chaves.
create or replace function public.repair_events_guard() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'registro imutável' using errcode = '42501';
  end if;
  if (new.action, new.actor, new.detail, new.created_at, new.request_id)
     is distinct from (old.action, old.actor, old.detail, old.created_at, old.request_id) then
    raise exception 'registro imutável' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists repair_events_immutable on public.repair_events;
create trigger repair_events_immutable before update or delete on public.repair_events
  for each row execute function public.repair_events_guard();

-- Fila futura de Análise (o módulo completo não faz parte do MVP): aparelhos com teste reprovado.
create table if not exists public.repair_analysis_queue (
  id uuid primary key default gen_random_uuid(),
  os_id uuid not null unique references public.service_orders (id) on delete cascade,
  stage_id uuid not null references public.repair_stages (id) on delete cascade,
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  failed_tests jsonb not null default '[]'::jsonb,
  status text not null default 'aguardando' check (status in ('aguardando', 'em_analise', 'concluida')),
  created_at timestamptz not null default now()
);

-- Permissões: leitura para quem trabalha no laboratório; nenhuma gravação direta ----------------------------
alter table public.repair_stages enable row level security;
alter table public.repair_checklist_results enable row level security;
alter table public.repair_timer_sessions enable row level security;
alter table public.repair_events enable row level security;
alter table public.repair_analysis_queue enable row level security;

grant select on public.repair_stages, public.repair_checklist_results, public.repair_timer_sessions,
  public.repair_events, public.repair_analysis_queue to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['repair_stages', 'repair_checklist_results', 'repair_timer_sessions', 'repair_events', 'repair_analysis_queue'] loop
    execute format('drop policy if exists "%1$s_select" on public.%1$s', t);
    execute format(
      'create policy "%1$s_select" on public.%1$s for select to authenticated
         using ((select public.has_any_role(array[''admin'', ''supervisor'', ''tecnico'', ''desmontador'', ''montador'', ''estoquista'']::public.user_role[])))',
      t);
  end loop;
end;
$$;

-- Funções internas ------------------------------------------------------------------------------------------
create or replace function public.repair_log(p_os uuid, p_stage uuid, p_request uuid, p_action text, p_detail jsonb default '{}')
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.repair_events (os_id, stage_id, request_id, action, detail)
  values (p_os, p_stage, p_request, p_action, coalesce(p_detail, '{}'::jsonb));
$$;

-- Troca o tipo da sessão aberta (null só encerra). Fecha e abre no mesmo instante.
create or replace function public.repair_timer_switch(p_stage uuid, p_kind text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_open public.repair_timer_sessions;
begin
  select * into v_open from public.repair_timer_sessions where stage_id = p_stage and ended_at is null for update;
  if found then
    if v_open.kind = p_kind then
      return;
    end if;
    update public.repair_timer_sessions set ended_at = v_now where id = v_open.id;
  end if;
  if p_kind is not null then
    insert into public.repair_timer_sessions (stage_id, kind, started_at) values (p_stage, p_kind, v_now);
  end if;
end;
$$;

-- Pedido de peça: o produtivo passa a "espera de peça". Pausa manual continua pausa.
create or replace function public.repair_timer_part_wait(p_stage uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.repair_timer_sessions where stage_id = p_stage and ended_at is null and kind = 'produtivo') then
    perform public.repair_timer_switch(p_stage, 'espera_peca');
  end if;
end;
$$;

-- Quem pode agir na etapa: o técnico dela ou o admin.
create or replace function public.repair_can_act(p_stage public.repair_stages) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select public.has_any_role(array['admin']::public.user_role[]))
      or ((select public.has_any_role(array['tecnico']::public.user_role[])) and p_stage.technician_id = (select auth.uid()));
$$;

revoke all on function public.repair_log(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.repair_timer_switch(uuid, text) from public, anon, authenticated;
revoke all on function public.repair_timer_part_wait(uuid) from public, anon, authenticated;
revoke all on function public.repair_can_act(public.repair_stages) from public, anon, authenticated;

-- Cronômetro: iniciar / retomar ('produtivo') e pausar ('pausa'). A espera de peça é automática.
create or replace function public.repair_timer_set(p_stage_id uuid, p_kind text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
begin
  if p_kind not in ('produtivo', 'pausa') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'etapa já concluída' using errcode = 'P0001';
  end if;
  perform public.repair_timer_switch(p_stage_id, p_kind);
  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'cronometro_' || p_kind);
end;
$$;

-- Totais em segundos por tipo, a sessão aberta contada até agora (hora do servidor, não do navegador).
create or replace function public.repair_timer_totals(p_stage_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'produtivo', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'produtivo'), 0)::bigint,
    'pausa', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'pausa'), 0)::bigint,
    'espera_peca', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'espera_peca'), 0)::bigint,
    'open_kind', (select o.kind from public.repair_timer_sessions o where o.stage_id = p_stage_id and o.ended_at is null),
    'server_now', now()
  )
  from (select 1) base
  left join public.repair_timer_sessions s on s.stage_id = p_stage_id
  where (select public.has_any_role(array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista']::public.user_role[]));
$$;

revoke all on function public.repair_timer_set(uuid, text) from public, anon;
revoke all on function public.repair_timer_totals(uuid) from public, anon;
grant execute on function public.repair_timer_set(uuid, text) to authenticated;
grant execute on function public.repair_timer_totals(uuid) to authenticated;
