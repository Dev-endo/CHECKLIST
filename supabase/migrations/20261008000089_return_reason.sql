-- Solicitar a devolução de uma peça de teste exige o motivo (mínimo 5 letras). Fica gravado na devolução e aparece
-- para o técnico e para o estoque. Devolução sem motivo é recusada ('return_reason_required').
-- Rode depois de 20261008000088_legacy_checklist_takeover.sql. Pode rodar de novo.

alter table public.stock_returns add column if not exists request_note text;
alter table public.stock_returns drop constraint if exists stock_returns_request_note_len;
alter table public.stock_returns
  add constraint stock_returns_request_note_len check (request_note is null or char_length(request_note) <= 1000);

-- A versão sem motivo sai: devolver agora exige a explicação (utilização definitiva continua sem motivo).
drop function if exists public.define_test_destiny(uuid, text);

create or replace function public.define_test_destiny(p_id uuid, p_destiny text, p_reason text default null) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.stock_requests;
  v_ret uuid;
  v_me uuid := (select auth.uid());
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not (select public.has_any_role(array['admin', 'tecnico', 'analista']::public.user_role[])) then
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
  if p_destiny = 'devolucao' and char_length(v_reason) < 5 then
    raise exception 'return_reason_required' using errcode = 'P0001';
  end if;

  update public.stock_requests set test_destiny = p_destiny, test_destiny_at = now(), test_destiny_by = v_me where id = p_id;
  perform public.stock_log(p_id, null, 'destino_teste', 0, 0,
    jsonb_build_object('destino', p_destiny, 'motivo', case when p_destiny = 'devolucao' then v_reason end), null);

  if p_destiny = 'devolucao' then
    insert into public.stock_returns (request_id, os_id, serial, part, reason, qty, request_note)
    values (r.id, r.os_id, r.serial, r.part, 'devolucao_teste', 1, left(v_reason, 1000))
    returning id into v_ret;
    perform public.stock_log(p_id, v_ret, 'devolucao_solicitada', 1, 0, jsonb_build_object('motivo', v_reason), null);
  end if;
  return v_ret;
end;
$$;

revoke all on function public.define_test_destiny(uuid, text, text) from public, anon;
grant execute on function public.define_test_destiny(uuid, text, text) to authenticated;
