-- Aba Vidro: cronômetro, "Concluir vidro" e, depois, "Entregar ao responsável" ou "Solicitar display".
-- Rode depois de 20261008000063_maintenance_to_glass.sql. Pode rodar de novo.
--
-- Fluxo do serviço de vidro:
--   aguardando --Começar vidro (liga o cronômetro)--> em_andamento --Concluir vidro (para o cronômetro)--> vidro_concluido
--   vidro_concluido --Entregar ao responsável--> concluido (o aparelho volta ao Estágio 2 de quem o desmontou)
--   vidro_concluido --Solicitar display--> concluido + pedido de Display ao estoque (o display morreu no processo);
--                                          o aparelho volta do mesmo jeito ao responsável, que recebe o display.

alter table public.repair_glass_jobs drop constraint if exists repair_glass_jobs_status_check;
alter table public.repair_glass_jobs
  add constraint repair_glass_jobs_status_check check (status in ('aguardando', 'em_andamento', 'vidro_concluido', 'concluido'));
alter table public.repair_glass_jobs add column if not exists glass_done_by uuid references public.profiles (id);
alter table public.repair_glass_jobs add column if not exists glass_done_at timestamptz;
alter table public.repair_glass_jobs add column if not exists display_requested boolean not null default false;

-- Cronômetro do vidro: a sessão pertence a uma etapa, a uma análise OU a um serviço de vidro.
alter table public.repair_timer_sessions
  add column if not exists glass_job_id uuid references public.repair_glass_jobs (id) on delete cascade;
alter table public.repair_timer_sessions drop constraint if exists repair_timer_owner_chk;
alter table public.repair_timer_sessions
  add constraint repair_timer_owner_chk check (num_nonnulls(stage_id, analysis_id, glass_job_id) = 1);
create unique index if not exists repair_timer_glass_open_idx
  on public.repair_timer_sessions (glass_job_id) where ended_at is null and glass_job_id is not null;

create or replace function public.repair_glass_timer_switch(p_job uuid, p_kind text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_open public.repair_timer_sessions;
begin
  select * into v_open from public.repair_timer_sessions where glass_job_id = p_job and ended_at is null for update;
  if found then
    if v_open.kind = p_kind then
      return;
    end if;
    update public.repair_timer_sessions set ended_at = v_now where id = v_open.id;
  end if;
  if p_kind is not null then
    insert into public.repair_timer_sessions (glass_job_id, kind, started_at) values (p_job, p_kind, v_now);
  end if;
end;
$$;

revoke all on function public.repair_glass_timer_switch(uuid, text) from public, anon, authenticated;

-- Pausar / retomar: quem começou o vidro (ou o admin), enquanto o vidro está em andamento.
create or replace function public.glass_timer_set(p_job_id uuid, p_kind text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.repair_glass_jobs;
begin
  if p_kind not in ('produtivo', 'pausa') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into j from public.repair_glass_jobs where id = p_job_id for update;
  if not found
     or not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[]))
     or (j.started_by is distinct from (select auth.uid()) and not (select public.has_any_role(array['admin']::public.user_role[]))) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if j.status <> 'em_andamento' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  perform public.repair_glass_timer_switch(p_job_id, p_kind);
end;
$$;

create or replace function public.glass_timer_totals(p_job_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'produtivo', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'produtivo'), 0)::bigint,
    'pausa', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'pausa'), 0)::bigint,
    'espera_peca', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'espera_peca'), 0)::bigint,
    'open_kind', (select o.kind from public.repair_timer_sessions o where o.glass_job_id = p_job_id and o.ended_at is null),
    'server_now', now()
  )
  from (select 1) base
  left join public.repair_timer_sessions s on s.glass_job_id = p_job_id
  where (select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]));
$$;

revoke all on function public.glass_timer_set(uuid, text) from public, anon;
revoke all on function public.glass_timer_totals(uuid) from public, anon;
grant execute on function public.glass_timer_set(uuid, text) to authenticated;
grant execute on function public.glass_timer_totals(uuid) to authenticated;

-- Começar vidro: liga o cronômetro.
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
  perform public.repair_glass_timer_switch(p_job_id, 'produtivo');
end;
$$;

-- Concluir vidro: para o cronômetro. Precisa do vidro entregue pelo estoque (o aro pode ter sido dispensado).
create or replace function public.complete_glass(p_job_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.repair_glass_jobs;
begin
  if not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into j from public.repair_glass_jobs where id = p_job_id for update;
  if not found or j.status <> 'em_andamento' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if j.started_by is distinct from (select auth.uid()) and not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if exists (select 1 from public.stock_requests
              where os_id = j.os_id and part_key in ('vidro', 'aro') and status in ('pendente', 'em_separacao', 'sem_estoque')) then
    raise exception 'glass_pending' using errcode = 'P0001';
  end if;
  perform public.repair_glass_timer_switch(p_job_id, null);
  update public.repair_glass_jobs
     set status = 'vidro_concluido', glass_done_by = (select auth.uid()), glass_done_at = now()
   where id = p_job_id;
  perform public.repair_log(j.os_id, j.stage_id, null, 'vidro_concluido');
end;
$$;

revoke all on function public.start_glass(uuid) from public, anon;
revoke all on function public.complete_glass(uuid) from public, anon;
grant execute on function public.start_glass(uuid) to authenticated;
grant execute on function public.complete_glass(uuid) to authenticated;

-- Entregar ao responsável (com ou sem pedido de display): o aparelho volta ao Estágio 2 de quem o desmontou.
drop function if exists public.finish_glass(uuid);

create or replace function public.finish_glass(p_job_id uuid, p_display boolean default false) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.repair_glass_jobs;
  v_stage uuid;
  v_round integer;
  v_req uuid;
begin
  if not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into j from public.repair_glass_jobs where id = p_job_id for update;
  if not found or j.status <> 'vidro_concluido' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;

  update public.repair_glass_jobs
     set status = 'concluido', finished_by = (select auth.uid()), finished_at = now(), display_requested = coalesce(p_display, false)
   where id = j.id;

  -- A rodada do serviço de vidro é a da etapa que o pediu (se a etapa sumiu, a mais recente da OS).
  select round into v_round from public.repair_stages where id = j.stage_id;
  if v_round is null then
    select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = j.os_id;
  end if;

  select id into v_stage from public.repair_stages where os_id = j.os_id and stage = 'manutencao' and round = v_round;
  if v_stage is null then
    insert into public.repair_stages (os_id, serial, stage, technician_id, round)
    values (j.os_id, j.serial, 'manutencao', j.responsible_id, v_round)
    returning id into v_stage;
  else
    update public.repair_stages
       set status = 'em_andamento', finished_at = null, outcome = null, resale_reason = null, failed_tests = '[]'::jsonb
     where id = v_stage and status = 'concluida';
  end if;

  -- O display morreu no processo: pede um display ao estoque, já na manutenção do responsável.
  if p_display then
    insert into public.stock_requests (os_id, stage_id, origin_stage, serial, part, purpose, qty)
    values (j.os_id, v_stage, 'manutencao', j.serial, 'Display', 'definitiva', 1)
    returning id into v_req;
    perform public.stock_log(v_req, null, 'solicitacao', 1, 0,
      jsonb_build_object('part', 'Display', 'purpose', 'definitiva', 'origem', 'vidro', 'motivo', 'display danificado no vidro'), null);
  end if;

  perform public.repair_log(j.os_id, v_stage, v_req, 'vidro_entregue',
    jsonb_build_object('responsavel', j.responsible_id, 'display_solicitado', coalesce(p_display, false)));
  return v_stage;
end;
$$;

revoke all on function public.finish_glass(uuid, boolean) from public, anon;
grant execute on function public.finish_glass(uuid, boolean) to authenticated;

-- Serviços que já estavam em andamento ganham o cronômetro desde que começaram.
insert into public.repair_timer_sessions (glass_job_id, kind, started_at, user_id)
select g.id, 'produtivo', g.started_at, g.started_by
from public.repair_glass_jobs g
where g.status = 'em_andamento' and g.started_at is not null
  and not exists (select 1 from public.repair_timer_sessions t where t.glass_job_id = g.id);
