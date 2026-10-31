-- Análise técnica: na troca de periférico, o próprio analista pode fazer o reparo (sem voltar ao Estágio 2).
-- Rode depois de 20261008000066_board_to_assembly_checklist.sql. Pode rodar de novo.
--
-- finish_analysis ganha p_self: com ele, a manutenção da troca fica em nome do analista (aba Análise técnica >
-- Checklist e montagem): ele recebe as peças, faz a troca, os checklists e a montagem e finaliza (aprovado vai para a
-- quarentena). Sem ele, como antes: o aparelho volta ao Estágio 2 de quem mandou para a análise.

drop function if exists public.finish_analysis(uuid, text, jsonb);

create or replace function public.finish_analysis(p_id uuid, p_result text, p_parts jsonb default '[]', p_self boolean default false) returns uuid
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
  v_kept boolean;
begin
  if not (select public.has_any_role(array['admin', 'analista']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_result not in ('troca_periferico', 'reparo_placa') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;

  select * into q from public.repair_analysis_queue where id = p_id for update;
  if not found or q.status <> 'em_analise' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if q.started_by is distinct from v_me and not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  -- Peça de teste da análise ainda aberta ou entregue sem destino: resolver antes de finalizar.
  if exists (select 1 from public.repair_analysis_parts(p_id) r
              where r.status in ('pendente', 'em_separacao', 'sem_estoque') or (r.status = 'entregue' and r.test_destiny is null)) then
    raise exception 'analysis_parts_pending' using errcode = 'P0001';
  end if;
  v_kept := exists (select 1 from public.repair_analysis_parts(p_id) r where r.test_destiny = 'utilizacao_definitiva');

  if p_result = 'troca_periferico' and not v_kept
     and (jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0) then
    raise exception 'parts_required' using errcode = 'P0001';
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
  -- O próprio analista faz a troca (checklist e montagem na Análise técnica) ou o aparelho volta a quem mandou.
  v_tech := case when p_self then v_me else coalesce(
    q.sent_by,
    v_src.technician_id,
    (select technician_id from public.repair_stages where os_id = q.os_id and stage = 'desmontagem' and round = v_round)
  ) end;

  select * into v_stage from public.repair_stages where os_id = q.os_id and stage = 'manutencao' and round = v_round;
  if not found then
    insert into public.repair_stages (os_id, serial, stage, technician_id, round)
    values (q.os_id, q.serial, 'manutencao', v_tech, v_round)
    returning * into v_stage;
  elsif v_stage.status = 'concluida' then
    update public.repair_stages
       set status = 'em_andamento', finished_at = null, outcome = null, resale_reason = null, failed_tests = '[]'::jsonb,
           technician_id = v_tech
     where id = v_stage.id
    returning * into v_stage;
  end if;

  -- As peças de teste da análise acompanham o aparelho no Estágio 2 (a definitiva vai junto, sem nova baixa).
  update public.stock_requests set stage_id = v_stage.id
   where id in (select r.id from public.repair_analysis_parts(p_id) r);

  if jsonb_typeof(p_parts) = 'array' then
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
    jsonb_build_object('resultado', p_result, 'pecas', p_parts, 'devolvido_a', v_tech, 'teste_definitivo', v_kept, 'feito_pelo_analista', p_self));
  return v_stage.id;
end;
$$;

revoke all on function public.finish_analysis(uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.finish_analysis(uuid, text, jsonb, boolean) to authenticated;
