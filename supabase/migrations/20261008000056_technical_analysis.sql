-- Reparo: aba Análise técnica (fila, começar análise, finalizar com troca de periférico ou reparo em placa).
-- Rode depois de 20261008000055_requarantine_new_round.sql. Pode rodar de novo.
--
-- Entram na fila: aparelhos que o Estágio 1 mandou para a Análise técnica e aparelhos cuja manutenção terminou com
-- teste reprovado. O analista clica em Começar análise; ao finalizar escolhe:
--   troca_periferico -> informa as peças (teste ou definitiva); cria os pedidos ao estoque e o aparelho vai ao Estágio 2;
--   reparo_placa     -> o aparelho vai direto ao Estágio 2.
-- O Estágio 2 é o da mesma rodada e fica com o técnico responsável (quem desmontou ou fez a manutenção).

alter table public.repair_analysis_queue add column if not exists started_by uuid references public.profiles (id);
alter table public.repair_analysis_queue add column if not exists started_at timestamptz;
alter table public.repair_analysis_queue add column if not exists finished_by uuid references public.profiles (id);
alter table public.repair_analysis_queue add column if not exists finished_at timestamptz;
alter table public.repair_analysis_queue add column if not exists result text;
alter table public.repair_analysis_queue drop constraint if exists repair_analysis_queue_result_check;
alter table public.repair_analysis_queue
  add constraint repair_analysis_queue_result_check check (result is null or result in ('troca_periferico', 'reparo_placa'));

-- Voltou à fila (nova reprovação ou novo envio do Estágio 1) depois de concluída: começa um ciclo novo.
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
  end if;
  return new;
end;
$$;

drop trigger if exists repair_queue_reopen on public.repair_analysis_queue;
create trigger repair_queue_reopen before update of failed_tests, stage_id on public.repair_analysis_queue
  for each row execute function public.repair_queue_reopen();

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
  perform public.repair_log(q.os_id, q.stage_id, null, 'analise_iniciada');
end;
$$;

-- p_parts: [{"part": "Display", "purpose": "teste" | "definitiva", "qty": 1}, ...] (obrigatório na troca de periférico).
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
  -- Quem começou a análise é quem finaliza (o admin também pode).
  if q.started_by is distinct from v_me and not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  select * into v_src from public.repair_stages where id = q.stage_id;
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = q.os_id and stage = 'desmontagem';
  v_tech := coalesce(
    v_src.technician_id,
    (select technician_id from public.repair_stages where os_id = q.os_id and stage = 'desmontagem' and round = v_round)
  );

  -- O Estágio 2 da rodada: abre (se ainda não existe) ou reabre (veio de manutenção reprovada).
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

  if p_result = 'troca_periferico' then
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
  end if;

  update public.repair_analysis_queue
     set status = 'concluida', result = p_result, finished_by = v_me, finished_at = now()
   where id = p_id;
  perform public.repair_log(q.os_id, v_stage.id, null, 'analise_concluida',
    jsonb_build_object('resultado', p_result, 'pecas', case when p_result = 'troca_periferico' then p_parts else '[]'::jsonb end));
  return v_stage.id;
end;
$$;

-- O técnico responsável também cancela o pedido que o analista fez na OS dele.
create or replace function public.cancel_stock_request(p_id uuid, p_reason text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.stock_requests;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_me uuid := (select auth.uid());
begin
  if not (select public.has_any_role(array['admin', 'tecnico', 'estoquista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into r from public.stock_requests where id = p_id for update;
  if not found then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  -- Técnico cancela o que ele pediu ou o que foi pedido na OS dele; estoquista e admin, qualquer um.
  if r.requested_by <> v_me
     and not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[]))
     and not exists (select 1 from public.repair_stages s where s.os_id = r.os_id and s.technician_id = v_me) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if r.status not in ('pendente', 'em_separacao', 'sem_estoque') or r.qty_delivered > 0 then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  update public.stock_requests
     set status = 'cancelada', cancel_reason = v_reason, cancelled_by = v_me, cancelled_at = now()
   where id = p_id;
  perform public.stock_log(p_id, null, 'cancelamento', 0, 0, jsonb_build_object('motivo', v_reason), null);
end;
$$;

revoke all on function public.repair_queue_reopen() from public, anon, authenticated;
revoke all on function public.start_analysis(uuid) from public, anon;
revoke all on function public.finish_analysis(uuid, text, jsonb) from public, anon;
revoke all on function public.cancel_stock_request(uuid, text) from public, anon;
grant execute on function public.start_analysis(uuid) to authenticated;
grant execute on function public.finish_analysis(uuid, text, jsonb) to authenticated;
grant execute on function public.cancel_stock_request(uuid, text) to authenticated;
