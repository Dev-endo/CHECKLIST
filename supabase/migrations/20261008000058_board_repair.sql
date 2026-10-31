-- Análise técnica: o reparo em placa fica na própria aba, como um segundo estágio ("Reparo em placa").
-- Rode depois de 20261008000057_analysis_timer.sql. Pode rodar de novo.
--
-- Fluxo:
--   Análise (analista) -> "Reparo em placa" -> o MESMO analista inicia o reparo (cronômetro) e finaliza com a
--   observação do serviço feito -> destino:
--     quarentena : não há mais reparo; o aparelho espera a quarentena (lista Aguardando);
--     vidro      : entra no mesmo processo de vidro dos Estágios 1 e 2;
--     estagio2   : ainda há outro reparo; o aparelho vai ao Estágio 2 do técnico responsável.
--   "Troca de periférico" continua como antes: pedidos de peça e Estágio 2 do técnico responsável.
-- Reprovado na quarentena também libera nova desmontagem (mesma OS) para quem passou por aqui.

-- Reparo em placa na fila de análise -------------------------------------------------------------------------------
alter table public.repair_analysis_queue add column if not exists board_status text;
alter table public.repair_analysis_queue add column if not exists board_by uuid references public.profiles (id);
alter table public.repair_analysis_queue add column if not exists board_started_at timestamptz;
alter table public.repair_analysis_queue add column if not exists board_finished_at timestamptz;
alter table public.repair_analysis_queue add column if not exists board_note text;
alter table public.repair_analysis_queue add column if not exists board_destination text;

alter table public.repair_analysis_queue drop constraint if exists repair_analysis_queue_board_status_check;
alter table public.repair_analysis_queue
  add constraint repair_analysis_queue_board_status_check check (board_status is null or board_status in ('aguardando', 'em_andamento', 'concluido'));
alter table public.repair_analysis_queue drop constraint if exists repair_analysis_queue_board_destination_check;
alter table public.repair_analysis_queue
  add constraint repair_analysis_queue_board_destination_check
  check (board_destination is null or board_destination in ('quarentena', 'vidro', 'estagio2'));

create index if not exists repair_analysis_board_idx on public.repair_analysis_queue (board_status) where board_status in ('aguardando', 'em_andamento');

-- Serviço de vidro pedido pelo reparo em placa.
alter table public.repair_glass_jobs drop constraint if exists repair_glass_jobs_origin_check;
alter table public.repair_glass_jobs
  add constraint repair_glass_jobs_origin_check check (origin in ('avaliacao', 'manutencao', 'analise'));

-- Cronômetro: a análise e o reparo em placa têm cada um o seu tempo.
alter table public.repair_timer_sessions add column if not exists phase text;
alter table public.repair_timer_sessions drop constraint if exists repair_timer_phase_check;
alter table public.repair_timer_sessions
  add constraint repair_timer_phase_check check (phase is null or phase in ('analise', 'reparo_placa'));
update public.repair_timer_sessions set phase = 'analise' where analysis_id is not null and phase is null;

-- Voltou à fila depois de concluída (nova reprovação ou novo envio): ciclo novo, tudo zerado.
create or replace function public.repair_queue_reopen() returns trigger
language plpgsql
as $$
begin
  if old.status = 'concluida' then
    new.status := 'aguardando';
    new.started_by := null;
    new.started_at := null;
    new.finished_by := null;
    new.finished_at := null;
    new.result := null;
    new.board_status := null;
    new.board_by := null;
    new.board_started_at := null;
    new.board_finished_at := null;
    new.board_note := null;
    new.board_destination := null;
  end if;
  return new;
end;
$$;

drop function if exists public.repair_analysis_timer_switch(uuid, text);

create or replace function public.repair_analysis_timer_switch(p_analysis uuid, p_kind text, p_phase text default 'analise') returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_open public.repair_timer_sessions;
begin
  select * into v_open from public.repair_timer_sessions where analysis_id = p_analysis and ended_at is null for update;
  if found then
    if v_open.kind = p_kind and v_open.phase is not distinct from p_phase then
      return;
    end if;
    update public.repair_timer_sessions set ended_at = v_now where id = v_open.id;
  end if;
  if p_kind is not null then
    insert into public.repair_timer_sessions (analysis_id, kind, started_at, phase) values (p_analysis, p_kind, v_now, p_phase);
  end if;
end;
$$;

revoke all on function public.repair_analysis_timer_switch(uuid, text, text) from public, anon, authenticated;

-- Iniciar / pausar / retomar o cronômetro da fase em andamento (análise ou reparo em placa), só pelo analista dela.
create or replace function public.analysis_timer_set(p_id uuid, p_kind text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.repair_analysis_queue;
  v_me uuid := (select auth.uid());
  v_admin boolean := (select public.has_any_role(array['admin']::public.user_role[]));
  v_phase text;
  v_owner uuid;
begin
  if p_kind not in ('produtivo', 'pausa') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found or not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if q.status = 'em_analise' then
    v_phase := 'analise';
    v_owner := q.started_by;
  elsif q.board_status = 'em_andamento' then
    v_phase := 'reparo_placa';
    v_owner := q.board_by;
  else
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if v_owner is distinct from v_me and not v_admin then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  perform public.repair_analysis_timer_switch(p_id, p_kind, v_phase);
  perform public.repair_log(q.os_id, q.stage_id, null, 'cronometro_' || v_phase || '_' || p_kind);
end;
$$;

drop function if exists public.analysis_timer_totals(uuid);

-- Totais da fase pedida: 'analise' (padrão) ou 'reparo_placa'.
create or replace function public.analysis_timer_totals(p_id uuid, p_phase text default 'analise') returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'produtivo', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'produtivo'), 0)::bigint,
    'pausa', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at)) filter (where s.kind = 'pausa'), 0)::bigint,
    'espera_peca', 0,
    'open_kind', (select o.kind from public.repair_timer_sessions o
                   where o.analysis_id = p_id and o.ended_at is null and o.phase is not distinct from p_phase),
    'server_now', now()
  )
  from (select 1) base
  left join public.repair_timer_sessions s on s.analysis_id = p_id and s.phase is not distinct from p_phase
  where (select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]));
$$;

revoke all on function public.analysis_timer_set(uuid, text) from public, anon;
revoke all on function public.analysis_timer_totals(uuid, text) from public, anon;
grant execute on function public.analysis_timer_set(uuid, text) to authenticated;
grant execute on function public.analysis_timer_totals(uuid, text) to authenticated;

-- Começar a análise liga o cronômetro da análise.
create or replace function public.start_analysis(p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.repair_analysis_queue;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found or q.status <> 'aguardando' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  update public.repair_analysis_queue
     set status = 'em_analise', started_by = (select auth.uid()), started_at = now()
   where id = p_id;
  perform public.repair_analysis_timer_switch(p_id, 'produtivo', 'analise');
  perform public.repair_log(q.os_id, q.stage_id, null, 'analise_iniciada');
end;
$$;

-- Finalizar a análise.
--   reparo_placa     -> o aparelho passa para a aba Reparo em placa (mesmo analista); não abre o Estágio 2 ainda.
--   troca_periferico -> pedidos de peça e Estágio 2 do técnico responsável (como antes).
create or replace function public.finish_analysis(p_id uuid, p_result text, p_parts jsonb default '[]') returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.repair_analysis_queue;
  v_me uuid := (select auth.uid());
  v_src public.repair_stages;
  v_stage public.repair_stages;
  v_round integer;
  v_tech uuid;
  v_item jsonb;
  v_part text;
  v_purpose text;
  v_qty integer;
  v_req uuid;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_result not in ('troca_periferico', 'reparo_placa') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  if p_result = 'troca_periferico' and (jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0) then
    raise exception 'parts_required' using errcode = 'P0001';
  end if;

  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found or q.status <> 'em_analise' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if q.started_by is distinct from v_me and not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  perform public.repair_analysis_timer_switch(p_id, null);

  if p_result = 'reparo_placa' then
    update public.repair_analysis_queue
       set status = 'concluida', result = p_result, finished_by = v_me, finished_at = now(), board_status = 'aguardando'
     where id = p_id;
    perform public.repair_log(q.os_id, q.stage_id, null, 'analise_concluida', jsonb_build_object('resultado', p_result));
    return null;
  end if;

  select * into v_src from public.repair_stages where id = q.stage_id;
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = q.os_id and stage = 'desmontagem';
  v_tech := coalesce(
    v_src.technician_id,
    (select technician_id from public.repair_stages where os_id = q.os_id and stage = 'desmontagem' and round = v_round)
  );

  select * into v_stage from public.repair_stages where os_id = q.os_id and stage = 'manutencao' and round = v_round;
  if not found then
    insert into public.repair_stages (os_id, serial, stage, technician_id, round)
    values (q.os_id, q.serial, 'manutencao', v_tech, v_round)
    returning * into v_stage;
  elsif v_stage.status = 'concluida' then
    update public.repair_stages
       set status = 'em_andamento', finished_at = null, outcome = null, resale_reason = null, failed_tests = '[]'::jsonb
     where id = v_stage.id
    returning * into v_stage;
  end if;

  for v_item in select * from jsonb_array_elements(p_parts) loop
    v_part := btrim(coalesce(v_item ->> 'part', ''));
    v_purpose := v_item ->> 'purpose';
    v_qty := case when v_purpose = 'teste' then 1 else coalesce((v_item ->> 'qty')::integer, 1) end;
    if v_part = '' or char_length(v_part) > 60 or v_purpose not in ('teste', 'definitiva') or v_qty not between 1 and 99 then
      raise exception 'dados incompletos' using errcode = '22023';
    end if;
    insert into public.stock_requests (os_id, stage_id, origin_stage, serial, part, purpose, qty)
    values (q.os_id, v_stage.id, 'manutencao', q.serial, v_part, v_purpose, v_qty)
    returning id into v_req;
    perform public.stock_log(v_req, null, 'solicitacao', v_qty, 0,
      jsonb_build_object('part', v_part, 'purpose', v_purpose, 'origem', 'analise_tecnica'), null);
  end loop;

  update public.repair_analysis_queue
     set status = 'concluida', result = p_result, finished_by = v_me, finished_at = now()
   where id = p_id;
  perform public.repair_log(q.os_id, v_stage.id, null, 'analise_concluida',
    jsonb_build_object('resultado', p_result, 'pecas', p_parts));
  return v_stage.id;
end;
$$;

-- Reparo em placa -----------------------------------------------------------------------------------------------------
-- Quem fez a análise (ou o admin) inicia; o cronômetro do reparo liga na hora.
create or replace function public.start_board_repair(p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.repair_analysis_queue;
  v_me uuid := (select auth.uid());
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found or q.result is distinct from 'reparo_placa' or q.board_status is distinct from 'aguardando' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if q.finished_by is distinct from v_me and not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  update public.repair_analysis_queue
     set board_status = 'em_andamento', board_by = v_me, board_started_at = now()
   where id = p_id;
  perform public.repair_analysis_timer_switch(p_id, 'produtivo', 'reparo_placa');
  perform public.repair_log(q.os_id, q.stage_id, null, 'reparo_placa_iniciado');
end;
$$;

-- Finaliza o reparo em placa com a observação do serviço feito e o destino do aparelho.
create or replace function public.finish_board_repair(p_id uuid, p_note text, p_destination text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.repair_analysis_queue;
  v_me uuid := (select auth.uid());
  v_note text := btrim(coalesce(p_note, ''));
  v_src public.repair_stages;
  v_stage public.repair_stages;
  v_round integer;
  v_tech uuid;
  v_out uuid;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_destination not in ('quarentena', 'vidro', 'estagio2') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found or q.board_status is distinct from 'em_andamento' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if q.board_by is distinct from v_me and not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if char_length(v_note) < 5 then
    raise exception 'note_required' using errcode = 'P0001';
  end if;

  select * into v_src from public.repair_stages where id = q.stage_id;
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = q.os_id and stage = 'desmontagem';
  v_tech := coalesce(
    v_src.technician_id,
    (select technician_id from public.repair_stages where os_id = q.os_id and stage = 'desmontagem' and round = v_round)
  );

  perform public.repair_analysis_timer_switch(p_id, null);
  update public.repair_analysis_queue
     set board_status = 'concluido', board_finished_at = now(), board_note = v_note, board_destination = p_destination
   where id = p_id;

  if p_destination = 'vidro' then
    perform public.repair_open_glass(v_src, 'analise', v_tech);
  elsif p_destination = 'estagio2' then
    select * into v_stage from public.repair_stages where os_id = q.os_id and stage = 'manutencao' and round = v_round;
    if not found then
      insert into public.repair_stages (os_id, serial, stage, technician_id, round)
      values (q.os_id, q.serial, 'manutencao', v_tech, v_round)
      returning * into v_stage;
    elsif v_stage.status = 'concluida' then
      update public.repair_stages
         set status = 'em_andamento', finished_at = null, outcome = null, resale_reason = null, failed_tests = '[]'::jsonb
       where id = v_stage.id
      returning * into v_stage;
    end if;
    v_out := v_stage.id;
  end if;

  perform public.repair_log(q.os_id, q.stage_id, null, 'reparo_placa_concluido',
    jsonb_build_object('destino', p_destination, 'observacao', v_note));
  return v_out;
end;
$$;

revoke all on function public.finish_analysis(uuid, text, jsonb) from public, anon;
revoke all on function public.start_board_repair(uuid) from public, anon;
revoke all on function public.finish_board_repair(uuid, text, text) from public, anon;
revoke all on function public.start_analysis(uuid) from public, anon;
grant execute on function public.finish_analysis(uuid, text, jsonb) to authenticated;
grant execute on function public.start_board_repair(uuid) to authenticated;
grant execute on function public.finish_board_repair(uuid, text, text) to authenticated;
grant execute on function public.start_analysis(uuid) to authenticated;

-- Quarentena: o que a manutenção OU o reparo em placa enviou ------------------------------------------------------
create or replace function public.repair_quarantine_sends()
returns table (os_id uuid, serial text, serial_key text, os_number text, os_created timestamptz, sender_id uuid, sent_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.os_id, s.serial, s.serial_key, o.os_number, o.created_at, s.technician_id, s.finished_at
  from public.repair_stages s
  join public.service_orders o on o.id = s.os_id
  where s.stage = 'manutencao' and s.status = 'concluida' and s.outcome = 'quarentena'
  union all
  select q.os_id, q.serial, q.serial_key, o.os_number, o.created_at, q.board_by, q.board_finished_at
  from public.repair_analysis_queue q
  join public.service_orders o on o.id = q.os_id
  where q.board_status = 'concluido' and q.board_destination = 'quarentena';
$$;

revoke all on function public.repair_quarantine_sends() from public, anon, authenticated;

create or replace function public.quarantine_pending()
returns table (
  serial text,
  os_number text,
  model text,
  unit text,
  technician text,
  sent_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.serial, s.os_number, a.model, a.asset_short_id,
         coalesce(nullif(btrim(p.name), ''), p.email) as technician,
         s.sent_at
  from public.repair_quarantine_sends() s
  join public.profiles p on p.id = s.sender_id
  left join public.assets a on a.serial_key = s.serial_key
  where (select public.has_any_role(
      array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]))
    and not exists (
      select 1 from public.quarantine_checks q
      where lower(btrim(q.serial)) = s.serial_key and q.created_at >= s.sent_at
    )
    and not exists (
      select 1 from public.service_orders newer
      where newer.serial_key = s.serial_key and newer.created_at > s.os_created
    )
  order by s.sent_at
  limit 1000;
$$;

revoke all on function public.quarantine_pending() from public, anon;
grant execute on function public.quarantine_pending() to authenticated;

-- Reprovado na quarentena libera nova desmontagem na mesma OS, venha o envio da manutenção ou do reparo em placa.
create or replace function public.redisassembly_allowed(p_serial text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.repair_quarantine_sends() s
    where s.serial_key = lower(btrim(coalesce(p_serial, '')))
      and (select public.has_any_role(array['admin', 'tecnico']::public.user_role[]))
      and s.os_created = (select max(x.created_at) from public.service_orders x where x.serial_key = s.serial_key)
      and s.sent_at = (select max(y.sent_at) from public.repair_quarantine_sends() y where y.os_id = s.os_id)
      and not exists (
        select 1 from public.repair_stages d where d.os_id = s.os_id and d.stage = 'desmontagem' and d.started_at > s.sent_at
      )
      and (
        select q.result from public.quarantine_checks q
        where lower(btrim(q.serial)) = s.serial_key and q.created_at >= s.sent_at
        order by q.created_at desc limit 1
      ) = 'reprovado'
  );
$$;

revoke all on function public.redisassembly_allowed(text) from public, anon;
grant execute on function public.redisassembly_allowed(text) to authenticated;
