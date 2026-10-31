-- Reparo, fim do Estágio 1: destinos Estágio 2, Vidro, Análise técnica e Aguardando peças; aba Vidro.
-- Rode depois de 20261008000051_roles_analista_vidro.sql (em execução separada). Pode rodar de novo.
--
-- Ao concluir a avaliação técnica, o técnico escolhe:
--   manutencao       -> abre o Estágio 2 (como antes);
--   vidro            -> encerra o Estágio 1; abre um serviço de vidro e pede Vidro e Aro ao estoque
--                       (o estoquista entrega ou dispensa o aro);
--   analise          -> encerra o Estágio 1; o aparelho entra na fila da aba Análise técnica;
--   aguardando_pecas -> encerra o Estágio 1; o Estágio 2 fica "aguardando_pecas" e abre sozinho
--                       quando o estoque resolver (entregar ou cancelar) todos os pedidos abertos da OS.
-- O técnico de vidro vê quem desmontou o aparelho e o entrega ao responsável, que segue no Estágio 2.

-- Papéis ---------------------------------------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_extra_roles_check;
alter table public.profiles
  add constraint profiles_extra_roles_check
  check (extra_roles <@ array['tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]);

-- Quem trabalha no laboratório lê ativos e OS (modelo, Unit ID e número da OS aparecem nas telas).
drop policy if exists "assets_select" on public.assets;
create policy "assets_select" on public.assets
  for select to authenticated
  using ((select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'montador', 'desmontador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[])));

drop policy if exists "service_orders_select" on public.service_orders;
create policy "service_orders_select" on public.service_orders
  for select to authenticated
  using ((select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[])));

do $$
declare
  t text;
begin
  foreach t in array array[
    'repair_stages', 'repair_checklist_results', 'repair_timer_sessions', 'repair_events', 'repair_analysis_queue',
    'stock_requests', 'stock_returns', 'stock_movements'
  ] loop
    execute format('drop policy if exists "%1$s_select" on public.%1$s', t);
    execute format(
      'create policy "%1$s_select" on public.%1$s for select to authenticated
         using ((select public.has_any_role(array[''admin'', ''supervisor'', ''tecnico'', ''desmontador'', ''montador'', ''estoquista'', ''analista'', ''tecnico_vidro'']::public.user_role[])))',
      t);
  end loop;
end;
$$;

-- Etapas -----------------------------------------------------------------------------------------------------------
alter table public.repair_stages drop constraint if exists repair_stages_status_check;
alter table public.repair_stages
  add constraint repair_stages_status_check check (status in ('em_andamento', 'concluida', 'aguardando_pecas'));

-- Para onde o Estágio 1 mandou o aparelho (na avaliação técnica concluída).
alter table public.repair_stages add column if not exists destination text;
alter table public.repair_stages drop constraint if exists repair_stages_destination_check;
alter table public.repair_stages
  add constraint repair_stages_destination_check
  check (destination is null or destination in ('manutencao', 'vidro', 'analise', 'aguardando_pecas'));

alter table public.repair_stages drop constraint if exists repair_stages_outcome_check;
alter table public.repair_stages
  add constraint repair_stages_outcome_check check (outcome in ('quarentena', 'analise', 'revenda', 'vidro'));

-- Fila da Análise técnica: de onde veio o aparelho.
alter table public.repair_analysis_queue add column if not exists source text not null default 'manutencao';
alter table public.repair_analysis_queue drop constraint if exists repair_analysis_queue_source_check;
alter table public.repair_analysis_queue
  add constraint repair_analysis_queue_source_check check (source in ('estagio1', 'manutencao'));

-- Serviços de vidro -----------------------------------------------------------------------------------------------
create table if not exists public.repair_glass_jobs (
  id uuid primary key default gen_random_uuid(),
  os_id uuid not null references public.service_orders (id) on delete cascade,
  stage_id uuid references public.repair_stages (id) on delete set null,
  serial text not null,
  serial_key text generated always as (lower(btrim(serial))) stored,
  -- De onde veio: avaliação técnica (Estágio 1) ou manutenção (Estágio 2).
  origin text not null check (origin in ('avaliacao', 'manutencao')),
  -- O técnico que desmontou/fez a manutenção: o aparelho volta para ele.
  responsible_id uuid not null references public.profiles (id),
  requested_by uuid not null default auth.uid() references public.profiles (id),
  status text not null default 'aguardando' check (status in ('aguardando', 'em_andamento', 'concluido')),
  started_by uuid references public.profiles (id),
  started_at timestamptz,
  finished_by uuid references public.profiles (id),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists repair_glass_open_idx on public.repair_glass_jobs (os_id) where status <> 'concluido';
create index if not exists repair_glass_status_idx on public.repair_glass_jobs (status, created_at);

alter table public.repair_glass_jobs enable row level security;
grant select on public.repair_glass_jobs to authenticated;
drop policy if exists "repair_glass_jobs_select" on public.repair_glass_jobs;
create policy "repair_glass_jobs_select" on public.repair_glass_jobs
  for select to authenticated
  using ((select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[])));

-- Abre o serviço de vidro e pede Vidro e Aro ao estoque (interno).
create or replace function public.repair_open_glass(p_stage public.repair_stages, p_origin text, p_responsible uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job uuid;
  v_part text;
  v_req uuid;
begin
  insert into public.repair_glass_jobs (os_id, stage_id, serial, origin, responsible_id)
  values (p_stage.os_id, p_stage.id, p_stage.serial, p_origin, p_responsible)
  returning id into v_job;

  foreach v_part in array array['Vidro', 'Aro'] loop
    insert into public.stock_requests (os_id, stage_id, origin_stage, serial, part, purpose, qty)
    values (p_stage.os_id, p_stage.id, case when p_origin = 'avaliacao' then 'avaliacao' else 'manutencao' end, p_stage.serial, v_part, 'definitiva', 1)
    returning id into v_req;
    perform public.stock_log(v_req, null, 'solicitacao', 1, 0, jsonb_build_object('part', v_part, 'purpose', 'definitiva', 'vidro', true), null);
  end loop;

  perform public.repair_log(p_stage.os_id, p_stage.id, null, 'vidro_solicitado', jsonb_build_object('origem', p_origin));
  return v_job;
end;
$$;

revoke all on function public.repair_open_glass(public.repair_stages, text, uuid) from public, anon, authenticated;

-- Fim do Estágio 1 ---------------------------------------------------------------------------------------------------
drop function if exists public.finish_evaluation(uuid);

create or replace function public.finish_evaluation(p_stage_id uuid, p_destination text default 'manutencao') returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
  v_next uuid;
begin
  if p_destination not in ('manutencao', 'vidro', 'analise', 'aguardando_pecas') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'avaliacao' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  if p_destination = 'aguardando_pecas'
     and not exists (select 1 from public.stock_requests
                      where os_id = v_stage.os_id and status in ('pendente', 'em_separacao', 'sem_estoque')) then
    raise exception 'nothing_to_wait' using errcode = 'P0001';
  end if;

  perform public.repair_timer_switch(p_stage_id, null);
  update public.repair_stages
     set status = 'concluida', finished_at = now(), destination = p_destination
   where id = p_stage_id;

  if p_destination in ('manutencao', 'aguardando_pecas') then
    insert into public.repair_stages (os_id, serial, stage, technician_id, status)
    values (v_stage.os_id, v_stage.serial, 'manutencao', v_stage.technician_id,
            case when p_destination = 'aguardando_pecas' then 'aguardando_pecas' else 'em_andamento' end)
    on conflict (os_id, stage) do nothing
    returning id into v_next;
    if v_next is null then
      select id into v_next from public.repair_stages where os_id = v_stage.os_id and stage = 'manutencao';
    end if;
    update public.stock_requests set stage_id = v_next
     where os_id = v_stage.os_id and status in ('pendente', 'em_separacao', 'sem_estoque') and stage_id = p_stage_id;

  elsif p_destination = 'vidro' then
    perform public.repair_open_glass(v_stage, 'avaliacao', v_stage.technician_id);

  else
    insert into public.repair_analysis_queue (os_id, stage_id, serial, source)
    values (v_stage.os_id, p_stage_id, v_stage.serial, 'estagio1')
    on conflict (os_id) do update set status = 'aguardando', stage_id = excluded.stage_id, source = 'estagio1';
  end if;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'avaliacao_concluida',
    jsonb_build_object('destino', p_destination, 'proxima_etapa', v_next));
  return v_next;
end;
$$;

-- Aguardando peças: o Estágio 2 abre sozinho quando não resta pedido aberto na OS.
create or replace function public.repair_release_waiting() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if new.status in ('entregue', 'cancelada') and old.status is distinct from new.status
     and not exists (select 1 from public.stock_requests
                      where os_id = new.os_id and status in ('pendente', 'em_separacao', 'sem_estoque')) then
    update public.repair_stages set status = 'em_andamento'
     where os_id = new.os_id and stage = 'manutencao' and status = 'aguardando_pecas'
    returning id into v_id;
    if v_id is not null then
      perform public.repair_log(new.os_id, v_id, null, 'pecas_recebidas', '{}');
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists stock_requests_release_waiting on public.stock_requests;
create trigger stock_requests_release_waiting after update of status on public.stock_requests
  for each row execute function public.repair_release_waiting();

-- Aba Vidro ------------------------------------------------------------------------------------------------------------
create or replace function public.start_glass(p_job_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  update public.repair_glass_jobs
     set status = 'em_andamento', started_by = (select auth.uid()), started_at = now()
   where id = p_job_id and status = 'aguardando';
  if not found then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
end;
$$;

-- O técnico de vidro termina e entrega ao responsável: o aparelho volta ao Estágio 2 dele.
create or replace function public.finish_glass(p_job_id uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.repair_glass_jobs;
  v_stage uuid;
begin
  if not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into j from public.repair_glass_jobs where id = p_job_id for update;
  if not found or j.status <> 'em_andamento' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  -- O vidro precisa ter sido entregue (ou cancelado) pelo estoque; o aro pode ser dispensado.
  if exists (select 1 from public.stock_requests
              where os_id = j.os_id and part_key in ('vidro', 'aro') and status in ('pendente', 'em_separacao', 'sem_estoque')) then
    raise exception 'glass_pending' using errcode = 'P0001';
  end if;

  update public.repair_glass_jobs set status = 'concluido', finished_by = (select auth.uid()), finished_at = now() where id = j.id;

  select id into v_stage from public.repair_stages where os_id = j.os_id and stage = 'manutencao';
  if v_stage is null then
    insert into public.repair_stages (os_id, serial, stage, technician_id)
    values (j.os_id, j.serial, 'manutencao', j.responsible_id)
    returning id into v_stage;
  else
    -- Veio do Estágio 2: reabre a manutenção para o responsável refazer o checklist e finalizar.
    update public.repair_stages
       set status = 'em_andamento', finished_at = null, outcome = null, resale_reason = null, failed_tests = '[]'::jsonb
     where id = v_stage and status = 'concluida';
  end if;

  perform public.repair_log(j.os_id, v_stage, null, 'vidro_entregue', jsonb_build_object('responsavel', j.responsible_id));
  return v_stage;
end;
$$;

revoke all on function public.finish_evaluation(uuid, text) from public, anon;
revoke all on function public.repair_release_waiting() from public, anon, authenticated;
revoke all on function public.start_glass(uuid) from public, anon;
revoke all on function public.finish_glass(uuid) from public, anon;
grant execute on function public.finish_evaluation(uuid, text) to authenticated;
grant execute on function public.start_glass(uuid) to authenticated;
grant execute on function public.finish_glass(uuid) to authenticated;
