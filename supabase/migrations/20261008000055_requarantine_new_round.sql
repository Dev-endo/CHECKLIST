-- Reparo: aparelho reprovado na quarentena pode ser desmontado de novo, com a mesma OS (nova "rodada").
-- Rode depois de 20261008000054_quarantine_everyone.sql. Pode rodar de novo.
--
-- Cada OS passa a poder ter várias rodadas de etapas (desmontagem -> avaliação -> manutenção). A rodada 1 é a de
-- sempre; uma nova rodada só abre quando a manutenção da rodada atual foi para a quarentena e o resultado mais recente
-- do serial depois do envio foi "reprovado". Nada da rodada anterior é apagado ou alterado: etapas, tempos, checklists,
-- pedidos de peça e movimentações continuam no histórico da OS.

alter table public.repair_stages add column if not exists round integer not null default 1;
alter table public.repair_stages drop constraint if exists repair_stages_round_check;
alter table public.repair_stages add constraint repair_stages_round_check check (round >= 1);

alter table public.repair_stages drop constraint if exists repair_stages_os_id_stage_key;
alter table public.repair_stages drop constraint if exists repair_stages_os_stage_round_key;
alter table public.repair_stages add constraint repair_stages_os_stage_round_key unique (os_id, stage, round);

-- O serial pode ser desmontado de novo? (Sim, quando a última manutenção foi para a quarentena e o resultado
-- mais recente depois do envio é "reprovado", e a nova desmontagem ainda não começou.)
create or replace function public.redisassembly_allowed(p_serial text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.service_orders o
    join public.repair_stages m
      on m.os_id = o.id and m.stage = 'manutencao' and m.status = 'concluida' and m.outcome = 'quarentena'
    where o.serial_key = lower(btrim(coalesce(p_serial, '')))
      and (select public.has_any_role(array['admin', 'tecnico']::public.user_role[]))
      -- Só a OS mais recente do serial.
      and o.created_at = (select max(x.created_at) from public.service_orders x where x.serial_key = o.serial_key)
      -- E só a rodada mais recente da OS (se a nova desmontagem já começou, não repete).
      and m.round = (select max(d.round) from public.repair_stages d where d.os_id = o.id and d.stage = 'desmontagem')
      and (
        select q.result from public.quarantine_checks q
        where lower(btrim(q.serial)) = o.serial_key and q.created_at >= m.finished_at
        order by q.created_at desc limit 1
      ) = 'reprovado'
  );
$$;

revoke all on function public.redisassembly_allowed(text) from public, anon;
grant execute on function public.redisassembly_allowed(text) to authenticated;

-- Abre a desmontagem na OS atual. Repetir devolve a mesma etapa; reprovado na quarentena abre uma nova rodada.
create or replace function public.start_disassembly(p_serial text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_last public.repair_stages;
  v_id uuid;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  v_os := public.current_os(p_serial);

  select * into v_last from public.repair_stages
   where os_id = v_os.id and stage = 'desmontagem' order by round desc limit 1;

  if not found then
    insert into public.repair_stages (os_id, serial, stage, technician_id)
    values (v_os.id, v_os.serial, 'desmontagem', (select auth.uid()))
    returning id into v_id;
    perform public.repair_log(v_os.id, v_id, null, 'desmontagem_iniciada');
    return v_id;
  end if;

  if public.redisassembly_allowed(p_serial) then
    insert into public.repair_stages (os_id, serial, stage, technician_id, round)
    values (v_os.id, v_os.serial, 'desmontagem', (select auth.uid()), v_last.round + 1)
    returning id into v_id;
    perform public.repair_log(v_os.id, v_id, null, 'desmontagem_reiniciada',
      jsonb_build_object('rodada', v_last.round + 1, 'motivo', 'reprovado na quarentena'));
    return v_id;
  end if;

  return v_last.id;
end;
$$;

-- Concluir a desmontagem: abre a avaliação técnica da mesma rodada.
create or replace function public.finish_disassembly(p_stage_id uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
  v_next uuid;
  v_created boolean := false;
begin
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'desmontagem' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;

  perform public.repair_timer_switch(p_stage_id, null);
  update public.repair_stages set status = 'concluida', finished_at = now() where id = p_stage_id;

  insert into public.repair_stages (os_id, serial, stage, technician_id, round)
  values (v_stage.os_id, v_stage.serial, 'avaliacao', v_stage.technician_id, v_stage.round)
  on conflict (os_id, stage, round) do nothing
  returning id into v_next;
  if v_next is null then
    select id into v_next from public.repair_stages where os_id = v_stage.os_id and stage = 'avaliacao' and round = v_stage.round;
  else
    v_created := true;
  end if;

  if v_created then
    perform public.repair_timer_switch(v_next, 'produtivo');
  end if;

  update public.stock_requests set stage_id = v_next
   where os_id = v_stage.os_id and status in ('pendente', 'em_separacao', 'sem_estoque') and stage_id = p_stage_id;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'desmontagem_concluida', jsonb_build_object('proxima_etapa', v_next));
  return v_next;
end;
$$;

-- Fim do Estágio 1: abre o Estágio 2 da mesma rodada (ou vidro, análise técnica, aguardando peças).
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
    insert into public.repair_stages (os_id, serial, stage, technician_id, status, round)
    values (v_stage.os_id, v_stage.serial, 'manutencao', v_stage.technician_id,
            case when p_destination = 'aguardando_pecas' then 'aguardando_pecas' else 'em_andamento' end, v_stage.round)
    on conflict (os_id, stage, round) do nothing
    returning id into v_next;
    if v_next is null then
      select id into v_next from public.repair_stages where os_id = v_stage.os_id and stage = 'manutencao' and round = v_stage.round;
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

-- O técnico de vidro entrega ao responsável: o aparelho volta ao Estágio 2 da mesma rodada.
create or replace function public.finish_glass(p_job_id uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.repair_glass_jobs;
  v_stage uuid;
  v_round integer;
begin
  if not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into j from public.repair_glass_jobs where id = p_job_id for update;
  if not found or j.status <> 'em_andamento' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.stock_requests
              where os_id = j.os_id and part_key in ('vidro', 'aro') and status in ('pendente', 'em_separacao', 'sem_estoque')) then
    raise exception 'glass_pending' using errcode = 'P0001';
  end if;

  update public.repair_glass_jobs set status = 'concluido', finished_by = (select auth.uid()), finished_at = now() where id = j.id;

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

  perform public.repair_log(j.os_id, v_stage, null, 'vidro_entregue', jsonb_build_object('responsavel', j.responsible_id));
  return v_stage;
end;
$$;

revoke all on function public.start_disassembly(text) from public, anon;
revoke all on function public.finish_disassembly(uuid) from public, anon;
revoke all on function public.finish_evaluation(uuid, text) from public, anon;
revoke all on function public.finish_glass(uuid) from public, anon;
grant execute on function public.start_disassembly(text) to authenticated;
grant execute on function public.finish_disassembly(uuid) to authenticated;
grant execute on function public.finish_evaluation(uuid, text) to authenticated;
grant execute on function public.finish_glass(uuid) to authenticated;
