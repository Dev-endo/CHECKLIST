-- MVP Reparo, banco 3/5: funções do estoque (solicitar, separar, entregar, cancelar, devolver, substituir).
-- Rode depois de 20261008000045_stock_requests_v2.sql. Pode rodar de novo.
--
-- Quem pode o quê:
--   técnico (e admin): solicitar, cancelar a própria solicitação, definir o destino do teste, pedir substituição.
--   estoquista (e admin): separar, marcar sem estoque, ENTREGAR, confirmar RECEBIMENTO físico, cancelar.
-- O técnico não tem como confirmar entrega nem recebimento: essas funções checam o papel.
--
-- Erros (mensagem): 42501 sem permissão; 22023 dados incompletos; no_os; 23505 pedido de teste repetido;
-- P0001 com: pedido já fechado, entrega acima do solicitado, destino já definido, devolução já recebida.

-- Registra a movimentação (interno). Com chave de idempotência, repetir a chamada não duplica.
-- Devolve false se a chave já existia.
create or replace function public.stock_log(
  p_request uuid, p_return uuid, p_kind text, p_qty integer, p_effect integer, p_detail jsonb, p_key text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.stock_requests;
  v_id bigint;
begin
  select * into v_req from public.stock_requests where id = p_request;
  insert into public.stock_movements (request_id, return_id, os_id, serial_key, kind, qty, stock_effect, detail, idempotency_key)
  values (p_request, p_return, v_req.os_id, v_req.serial_key, p_kind, coalesce(p_qty, 0), coalesce(p_effect, 0),
          coalesce(p_detail, '{}'::jsonb), p_key)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is not null then
    perform public.repair_log(v_req.os_id, v_req.stage_id, p_request, 'estoque_' || p_kind, coalesce(p_detail, '{}'::jsonb));
  end if;
  return v_id is not null;
end;
$$;

revoke all on function public.stock_log(uuid, uuid, text, integer, integer, jsonb, text) from public, anon, authenticated;

-- Solicitar peça (teste ou definitiva) na OS atual do serial. Pausa o cronômetro da etapa em andamento.
create or replace function public.create_stock_request(p_serial text, p_part text, p_purpose text, p_qty integer default 1)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_stage public.repair_stages;
  v_part text := btrim(coalesce(p_part, ''));
  v_id uuid;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_part = '' or char_length(v_part) > 60 or p_purpose not in ('teste', 'definitiva') or coalesce(p_qty, 0) not between 1 and 99 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  if p_purpose = 'teste' and p_qty <> 1 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;

  v_os := public.current_os(p_serial);
  select * into v_stage from public.repair_stages
   where os_id = v_os.id and status = 'em_andamento' order by started_at desc limit 1;

  insert into public.stock_requests (os_id, stage_id, origin_stage, serial, part, purpose, qty)
  values (v_os.id, v_stage.id, v_stage.stage, v_os.serial, v_part, p_purpose, p_qty)
  returning id into v_id;

  perform public.stock_log(v_id, null, 'solicitacao', p_qty, 0, jsonb_build_object('part', v_part, 'purpose', p_purpose), null);
  if v_stage.id is not null then
    perform public.repair_timer_part_wait(v_stage.id);
  end if;
  return v_id;
end;
$$;

-- Estoquista: separação / sem estoque.
create or replace function public.set_stock_request_status(p_id uuid, p_status text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.stock_requests;
begin
  if not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_status not in ('em_separacao', 'sem_estoque') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into r from public.stock_requests where id = p_id for update;
  if not found or r.status not in ('pendente', 'em_separacao', 'sem_estoque') then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if r.status = p_status then
    return;
  end if;
  update public.stock_requests set status = p_status where id = p_id;
  perform public.stock_log(p_id, null, case p_status when 'em_separacao' then 'separacao' else 'sem_estoque' end, 0, 0, '{}', null);
end;
$$;

-- Estoquista: confirma a entrega física. p_items = [{"id": uuid, "qty": n}, ...]; um registro por solicitação.
-- p_key identifica o lote (gerado pela tela a cada confirmação): reenviar o mesmo lote não entrega de novo.
create or replace function public.deliver_stock_requests(p_items jsonb, p_key text) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  r public.stock_requests;
  v_qty integer;
  v_done integer := 0;
begin
  if not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or coalesce(btrim(p_key), '') = '' then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into r from public.stock_requests where id = (v_item ->> 'id')::uuid for update;
    if not found then
      raise exception 'dados incompletos' using errcode = '22023';
    end if;
    v_qty := coalesce((v_item ->> 'qty')::integer, r.qty - r.qty_delivered);
    if r.status not in ('pendente', 'em_separacao', 'sem_estoque') then
      -- Lote reenviado: a entrega desta solicitação já foi gravada com a mesma chave.
      if exists (select 1 from public.stock_movements where idempotency_key = p_key || ':' || r.id) then
        continue;
      end if;
      raise exception 'pedido já fechado' using errcode = 'P0001';
    end if;
    if v_qty < 1 or v_qty > r.qty - r.qty_delivered then
      raise exception 'entrega acima do solicitado' using errcode = 'P0001';
    end if;

    if public.stock_log(r.id, null, 'entrega', v_qty, -v_qty, jsonb_build_object('lote', p_key), p_key || ':' || r.id) then
      update public.stock_requests
         set qty_delivered = qty_delivered + v_qty,
             status = case when qty_delivered + v_qty = qty then 'entregue' else 'em_separacao' end
       where id = r.id;
      v_done := v_done + 1;
    end if;
  end loop;
  return v_done;
end;
$$;

-- Cancelar solicitação ainda não entregue (nada entregue), com justificativa obrigatória.
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
  -- Técnico cancela só o que ele pediu; estoquista e admin, qualquer um.
  if r.requested_by <> v_me and not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[])) then
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

-- Técnico: destino da peça de teste entregue. 'utilizacao_definitiva' não baixa o estoque de novo;
-- 'devolucao' abre a devolução (sem justificativa) que o estoque precisa receber.
create or replace function public.define_test_destiny(p_id uuid, p_destiny text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.stock_requests;
  v_ret uuid;
  v_me uuid := (select auth.uid());
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_destiny not in ('utilizacao_definitiva', 'devolucao') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into r from public.stock_requests where id = p_id for update;
  if not found or r.purpose <> 'teste' or r.status <> 'entregue' then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  if r.test_destiny is not null then
    raise exception 'destino já definido' using errcode = 'P0001';
  end if;

  update public.stock_requests set test_destiny = p_destiny, test_destiny_at = now(), test_destiny_by = v_me where id = p_id;
  perform public.stock_log(p_id, null, 'destino_teste', 0, 0, jsonb_build_object('destino', p_destiny), null);

  if p_destiny = 'devolucao' then
    insert into public.stock_returns (request_id, os_id, serial, part, reason, qty)
    values (r.id, r.os_id, r.serial, r.part, 'devolucao_teste', 1)
    returning id into v_ret;
    perform public.stock_log(p_id, v_ret, 'devolucao_solicitada', 1, 0, '{}', null);
  end if;
  return v_ret;
end;
$$;

-- Técnico: peça definitiva entregue veio com defeito. Cria a solicitação substituta (vinculada à original)
-- e a devolução da peça defeituosa, que o estoque precisa receber antes de a manutenção ser finalizada.
create or replace function public.request_replacement(p_request_id uuid, p_qty integer default 1) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.stock_requests;
  v_stage public.repair_stages;
  v_new uuid;
  v_ret uuid;
  v_already integer;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into r from public.stock_requests where id = p_request_id for update;
  if not found or r.purpose <> 'definitiva' or r.qty_delivered < 1 or coalesce(p_qty, 0) < 1 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select coalesce(sum(qty), 0) into v_already
    from public.stock_returns where request_id = r.id and reason = 'substituicao_defeito';
  if v_already + p_qty > r.qty_delivered then
    raise exception 'substituição acima do entregue' using errcode = 'P0001';
  end if;

  select * into v_stage from public.repair_stages
   where os_id = r.os_id and status = 'em_andamento' order by started_at desc limit 1;

  insert into public.stock_returns (request_id, os_id, serial, part, reason, qty)
  values (r.id, r.os_id, r.serial, r.part, 'substituicao_defeito', p_qty)
  returning id into v_ret;

  insert into public.stock_requests (os_id, stage_id, origin_stage, serial, part, purpose, qty, replaces_request_id)
  values (r.os_id, v_stage.id, v_stage.stage, r.serial, r.part, 'definitiva', p_qty, r.id)
  returning id into v_new;

  perform public.stock_log(r.id, v_ret, 'substituicao_solicitada', p_qty, 0, jsonb_build_object('substituta', v_new), null);
  perform public.stock_log(v_new, null, 'solicitacao', p_qty, 0,
    jsonb_build_object('part', r.part, 'purpose', 'definitiva', 'substitui', r.id), null);
  if v_stage.id is not null then
    perform public.repair_timer_part_wait(v_stage.id);
  end if;
  return v_new;
end;
$$;

-- Estoquista: confirma o recebimento físico de uma devolução e classifica a peça.
-- Só 'funcional' volta ao estoque disponível; as outras ficam segregadas (view stock_segregated).
create or replace function public.confirm_stock_return(p_return_id uuid, p_condition text, p_key text default null) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.stock_returns;
  v_me uuid := (select auth.uid());
begin
  if not (select public.has_any_role(array['admin', 'estoquista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_condition not in ('funcional', 'com_defeito', 'necessita_avaliacao') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into r from public.stock_returns where id = p_return_id for update;
  if not found then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  if r.status <> 'aguardando_recebimento' then
    raise exception 'devolução já recebida' using errcode = 'P0001';
  end if;

  update public.stock_returns
     set status = 'recebida', received_by = v_me, received_at = now(), condition = p_condition
   where id = r.id;
  perform public.stock_log(r.request_id, r.id, 'recebimento', r.qty, 0, jsonb_build_object('condicao', p_condition),
    case when p_key is null then null else p_key || ':rec' end);
  if p_condition = 'funcional' then
    perform public.stock_log(r.request_id, r.id, 'retorno_disponivel', r.qty, r.qty, '{}',
      case when p_key is null then null else p_key || ':disp' end);
  else
    perform public.stock_log(r.request_id, r.id, 'segregacao', r.qty, 0, jsonb_build_object('condicao', p_condition),
      case when p_key is null then null else p_key || ':seg' end);
  end if;
end;
$$;

revoke all on function public.create_stock_request(text, text, text, integer) from public, anon;
revoke all on function public.set_stock_request_status(uuid, text) from public, anon;
revoke all on function public.deliver_stock_requests(jsonb, text) from public, anon;
revoke all on function public.cancel_stock_request(uuid, text) from public, anon;
revoke all on function public.define_test_destiny(uuid, text) from public, anon;
revoke all on function public.request_replacement(uuid, integer) from public, anon;
revoke all on function public.confirm_stock_return(uuid, text, text) from public, anon;
grant execute on function public.create_stock_request(text, text, text, integer) to authenticated;
grant execute on function public.set_stock_request_status(uuid, text) to authenticated;
grant execute on function public.deliver_stock_requests(jsonb, text) to authenticated;
grant execute on function public.cancel_stock_request(uuid, text) to authenticated;
grant execute on function public.define_test_destiny(uuid, text) to authenticated;
grant execute on function public.request_replacement(uuid, integer) to authenticated;
grant execute on function public.confirm_stock_return(uuid, text, text) to authenticated;
