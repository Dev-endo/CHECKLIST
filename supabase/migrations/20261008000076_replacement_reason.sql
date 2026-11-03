-- Peça com defeito: substituir. O técnico escolhe o tipo de falha (Falha técnica ou Falha de teste) e explica por que
-- está substituindo a peça. Fica gravado na solicitação substituta (aparece para o técnico e no quadro do estoque).
-- Rode depois de 20261008000075_my_production.sql. Pode rodar de novo.

alter table public.stock_requests add column if not exists replace_failure text;
alter table public.stock_requests add column if not exists replace_reason text;
alter table public.stock_requests drop constraint if exists stock_requests_replace_failure_check;
alter table public.stock_requests
  add constraint stock_requests_replace_failure_check check (replace_failure is null or replace_failure in ('falha_tecnica', 'falha_teste'));

-- A versão antiga (sem motivo) sai: substituir agora exige o tipo de falha e a explicação.
drop function if exists public.request_replacement(uuid, integer);

create or replace function public.request_replacement(p_request_id uuid, p_qty integer, p_failure text, p_reason text) returns uuid
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
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not (select public.has_any_role(array['admin', 'tecnico', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if coalesce(p_failure, '') not in ('falha_tecnica', 'falha_teste') then
    raise exception 'replace_failure_required' using errcode = 'P0001';
  end if;
  if char_length(v_reason) < 5 then
    raise exception 'replace_reason_required' using errcode = 'P0001';
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

  insert into public.stock_requests (os_id, stage_id, origin_stage, serial, part, purpose, qty, replaces_request_id, replace_failure, replace_reason)
  values (r.os_id, v_stage.id, v_stage.stage, r.serial, r.part, 'definitiva', p_qty, r.id, p_failure, left(v_reason, 500))
  returning id into v_new;

  perform public.stock_log(r.id, v_ret, 'substituicao_solicitada', p_qty, 0,
    jsonb_build_object('substituta', v_new, 'falha', p_failure, 'motivo', left(v_reason, 500)), null);
  perform public.stock_log(v_new, null, 'solicitacao', p_qty, 0,
    jsonb_build_object('part', r.part, 'purpose', 'definitiva', 'substitui', r.id, 'falha', p_failure, 'motivo', left(v_reason, 500)), null);
  if v_stage.id is not null then
    perform public.repair_timer_part_wait(v_stage.id);
  end if;
  return v_new;
end;
$$;

revoke all on function public.request_replacement(uuid, integer, text, text) from public, anon;
grant execute on function public.request_replacement(uuid, integer, text, text) to authenticated;
