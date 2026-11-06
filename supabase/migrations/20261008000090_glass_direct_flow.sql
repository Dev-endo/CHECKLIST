-- Aba Vidro: o técnico de vidro recebe o aparelho direto (bipa o serial), com ou sem desmontagem, faz o vidro e segue
-- para o checklist aberto, a montagem e o checklist fechado (a mesma tela do Estágio 2 do Reparo). Na falha, ele pode
-- direcionar o aparelho para um técnico de manutenção.
-- Rode depois de 20261008000089_return_reason.sql. Pode rodar de novo.
--
-- Fluxo (tudo na mesma OS):
--   start_glass_flow(serial, desmontar?)
--     sim -> abre a desmontagem do técnico de vidro e já pede Vidro e Aro ao estoque (os pedidos esperam o vidro);
--            finish_glass_flow_disassembly abre o serviço de vidro (sem avaliação técnica);
--     não -> abre o serviço de vidro direto (e pede Vidro e Aro).
--   Serviço de vidro (Começar, Concluir) é o de sempre; "Entregar" (finish_glass) agora abre a manutenção do próprio
--   técnico de vidro: checklist aberto -> montagem -> checklist fechado -> finalizar.
--   hand_over_maintenance: destino "Manutenção": passa a etapa para o técnico escolhido, com o motivo.

-- 1) Marcações novas ------------------------------------------------------------------------------------------------
alter table public.repair_stages add column if not exists flow text not null default 'reparo';
alter table public.repair_stages drop constraint if exists repair_stages_flow_check;
alter table public.repair_stages add constraint repair_stages_flow_check check (flow in ('reparo', 'vidro'));

-- Quem recebeu a etapa de outro técnico (destino Manutenção), com o motivo.
alter table public.repair_stages add column if not exists handover_from uuid references public.profiles (id);
alter table public.repair_stages add column if not exists handover_note text;
alter table public.repair_stages add column if not exists handover_at timestamptz;

alter table public.repair_glass_jobs drop constraint if exists repair_glass_jobs_origin_check;
alter table public.repair_glass_jobs
  add constraint repair_glass_jobs_origin_check check (origin in ('avaliacao', 'manutencao', 'analise', 'vidro'));

-- 2) Permissões ------------------------------------------------------------------------------------------------------
-- O técnico de vidro age nas etapas que são dele (a desmontagem e a manutenção do fluxo do vidro).
create or replace function public.repair_can_act(p_stage public.repair_stages) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select public.has_any_role(array['admin']::public.user_role[]))
      or ((select public.has_any_role(array['tecnico', 'analista', 'tecnico_vidro']::public.user_role[]))
          and p_stage.technician_id = (select auth.uid()));
$$;

revoke all on function public.repair_can_act(public.repair_stages) from public, anon, authenticated;

-- O técnico de vidro também registra a OS do ativo que chega direto no vidro.
drop policy if exists "service_orders_insert" on public.service_orders;
create policy "service_orders_insert" on public.service_orders
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.has_any_role(array['admin', 'desmontador', 'tecnico', 'tecnico_vidro']::public.user_role[]))
  );

-- 3) Começar o fluxo -------------------------------------------------------------------------------------------------
-- Devolve o id da desmontagem (com desmontagem) ou do serviço de vidro (sem desmontagem).
-- Só começa em OS sem etapas do Reparo: o aparelho que já está no Reparo segue por lá.
create or replace function public.start_glass_flow(p_serial text, p_disassemble boolean) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_me uuid := (select auth.uid());
  v_stage public.repair_stages;
  v_fake public.repair_stages;
  v_id uuid;
begin
  if not (select public.has_any_role(array['admin', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_disassemble is null then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  v_os := public.current_os(p_serial);

  if exists (select 1 from public.repair_stages where os_id = v_os.id and flow <> 'vidro') then
    raise exception 'os_in_use' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.repair_glass_jobs where os_id = v_os.id and status <> 'concluido') then
    raise exception 'glass_open' using errcode = 'P0001';
  end if;
  -- Repetir devolve a desmontagem que já está em andamento.
  select id into v_id from public.repair_stages
   where os_id = v_os.id and stage = 'desmontagem' and flow = 'vidro' and status = 'em_andamento'
   order by round desc limit 1;
  if found then
    return v_id;
  end if;
  -- Fluxo do vidro já concluído nesta OS: o aparelho voltou ao laboratório, então precisa de uma OS nova.
  if exists (select 1 from public.repair_stages where os_id = v_os.id) then
    raise exception 'os_in_use' using errcode = 'P0001';
  end if;

  if p_disassemble then
    insert into public.repair_stages (os_id, serial, stage, technician_id, flow, needs_glass)
    values (v_os.id, v_os.serial, 'desmontagem', v_me, 'vidro', true)
    returning * into v_stage;
    -- Vidro e Aro já vão para o estoque (a etapa fica marcada: o serviço de vidro não pede de novo).
    perform public.repair_request_glass_parts(v_stage, 'desmontagem');
    perform public.repair_log(v_os.id, v_stage.id, null, 'desmontagem_iniciada', jsonb_build_object('fluxo', 'vidro'));
    return v_stage.id;
  end if;

  -- Sem desmontagem: abre o serviço de vidro direto (sem etapa de origem) e pede Vidro e Aro.
  v_fake.os_id := v_os.id;
  v_fake.serial := v_os.serial;
  v_id := public.repair_open_glass(v_fake, 'vidro', v_me);
  perform public.repair_log(v_os.id, null, null, 'vidro_direto_sem_desmontagem', jsonb_build_object('servico', v_id));
  return v_id;
end;
$$;

revoke all on function public.start_glass_flow(text, boolean) from public, anon;
grant execute on function public.start_glass_flow(text, boolean) to authenticated;

-- Concluir a desmontagem do fluxo do vidro: abre o serviço de vidro (sem avaliação técnica).
create or replace function public.finish_glass_flow_disassembly(p_stage_id uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
  v_job uuid;
begin
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'desmontagem' or v_stage.flow <> 'vidro' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;

  perform public.repair_timer_switch(p_stage_id, null);
  update public.repair_stages set status = 'concluida', finished_at = now() where id = p_stage_id;

  -- Vidro e Aro já foram pedidos ao começar (needs_glass): o serviço não pede de novo.
  v_job := public.repair_open_glass(v_stage, 'vidro', v_stage.technician_id);
  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'desmontagem_concluida',
    jsonb_build_object('fluxo', 'vidro', 'servico_vidro', v_job));
  return v_job;
end;
$$;

revoke all on function public.finish_glass_flow_disassembly(uuid) from public, anon;
grant execute on function public.finish_glass_flow_disassembly(uuid) to authenticated;

-- 4) Destino Manutenção -----------------------------------------------------------------------------------------------
-- Técnicos de manutenção que podem receber o aparelho (função principal ou extra: Técnico).
create or replace function public.list_maintenance_technicians() returns table (id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, coalesce(nullif(btrim(p.name), ''), p.email)
    from public.profiles p
   where (select public.has_any_role(array['admin', 'tecnico', 'tecnico_vidro']::public.user_role[]))
     and (p.role = 'tecnico' or 'tecnico'::public.user_role = any (p.extra_roles))
   order by 2;
$$;

revoke all on function public.list_maintenance_technicians() from public, anon;
grant execute on function public.list_maintenance_technicians() to authenticated;

-- Passa a manutenção em andamento para outro técnico (as marcações ficam; o cronômetro de quem passou é encerrado).
-- O técnico escolhido encontra o aparelho no Estágio 2 do Reparo, com o motivo.
create or replace function public.hand_over_maintenance(p_stage_id uuid, p_technician uuid, p_note text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
  v_note text := btrim(coalesce(p_note, ''));
begin
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'manutencao' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  if char_length(v_note) < 5 then
    raise exception 'handover_note_required' using errcode = 'P0001';
  end if;
  if p_technician is null or p_technician = v_stage.technician_id or not exists (
       select 1 from public.profiles p
        where p.id = p_technician and (p.role = 'tecnico' or 'tecnico'::public.user_role = any (p.extra_roles))) then
    raise exception 'handover_target_invalid' using errcode = 'P0001';
  end if;

  perform public.repair_timer_switch(p_stage_id, null);
  update public.repair_stages
     set technician_id = p_technician, handover_from = v_stage.technician_id,
         handover_note = left(v_note, 1000), handover_at = now()
   where id = p_stage_id;

  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'direcionado_manutencao',
    jsonb_build_object('de', v_stage.technician_id, 'para', p_technician, 'motivo', v_note));
end;
$$;

revoke all on function public.hand_over_maintenance(uuid, uuid, text) from public, anon;
grant execute on function public.hand_over_maintenance(uuid, uuid, text) to authenticated;
