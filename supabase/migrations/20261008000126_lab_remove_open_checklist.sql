-- Retirar ativo do técnico mesmo com o checklist já aberto (ajuste da migration 124). Rode depois de
-- 20261008000125_lab_flow.sql. Pode rodar de novo.
--
--   * lab_remove(p_serials, p_force): sem p_force, o checklist aberto devolve 'checklist_aberto' (a tela mostra o aviso);
--     com p_force, retira assim mesmo. O checklist fica salvo (com as marcações), parado: o técnico anterior não segue
--     com ele; se o ativo for entregue de novo, quem recebe assume o checklist.
--   * start_legacy_maintenance (corpo da migration 121): assume o checklist do ativo retirado / barra o técnico anterior.

drop function if exists public.lab_remove(text[]);

create or replace function public.lab_remove(p_serials text[], p_force boolean default false)
returns table (serial text, ok boolean, reason text, previous text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_serial text;
  b public.lab_balloons;
  v_before text;
  v_status text;
  v_drop boolean;
  v_checklist uuid;
begin
  if not (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if coalesce(array_length(p_serials, 1), 0) = 0 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;

  for v_serial in
    select min(btrim(s)) from unnest(p_serials) s where btrim(coalesce(s, '')) <> '' group by lower(btrim(s))
  loop
    select * into b from public.lab_balloons x
     where x.serial_key = lower(v_serial) and x.status in ('pendente', 'aberto')
     for update;
    if not found then
      serial := v_serial; ok := false; reason := 'sem_balao'; previous := null;
      return next;
      continue;
    end if;
    v_checklist := (select st.id from public.repair_stages st where st.id = b.stage_id and st.status = 'em_andamento');
    if v_checklist is not null and not coalesce(p_force, false) then
      serial := v_serial; ok := false; reason := 'checklist_aberto'; previous := public.lab_name(b.technician_id);
      return next;
      continue;
    end if;

    perform 1 from public.lab_assets a where a.id = b.asset_id for update;
    -- Onde o ativo estava antes da entrega (gravado no movimento que criou o balão).
    select e.detail ->> 'status_anterior' into v_before
      from public.lab_events e
     where e.balloon_id = b.id and e.kind in ('entrega', 'direcionamento_vidro', 'redistribuicao')
     order by e.created_at, e.seq limit 1;

    v_drop := b.source = 'entrega'
      and coalesce(v_before, 'aguardando_manutencao') = 'aguardando_manutencao'
      and not exists (select 1 from public.lab_balloons o where o.asset_id = b.asset_id and o.id <> b.id)
      and not exists (select 1 from public.lab_events e where e.asset_id = b.asset_id and e.kind = 'reentrada');

    perform public.lab_log(case when v_drop then null else b.asset_id end, null, b.serial, 'retirado', b.technician_id, null,
      jsonb_build_object('por', 'supervisor', 'status', b.status, 'origem', b.source,
                         'passagem', case when v_drop then 'apagada' else 'mantida' end, 'checklist', v_checklist));
    delete from public.lab_balloons where id = b.id;

    if v_drop then
      -- O histórico fica pelo serial; a passagem some (sai de "Entraram").
      update public.lab_events set asset_id = null where asset_id = b.asset_id;
      delete from public.lab_assets where id = b.asset_id;
    else
      v_status := case b.source
        when 'vidro' then 'vidro'
        when 'redistribuicao' then 'reprovado_aguardando'
        else 'aguardando_manutencao' end;
      update public.lab_assets
         set status = v_status, technician_id = null, last_move_at = now()
       where id = b.asset_id;
    end if;

    serial := v_serial; ok := true; reason := null; previous := public.lab_name(b.technician_id);
    return next;
  end loop;
end;
$$;

revoke all on function public.lab_remove(text[], boolean) from public, anon;
grant execute on function public.lab_remove(text[], boolean) to authenticated;

create or replace function public.start_legacy_maintenance(p_serial text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_round integer;
  v_stage public.repair_stages;
  v_me uuid := (select auth.uid());
  v_admin boolean := (select public.has_any_role(array['admin']::public.user_role[]));
  v_balloon public.lab_balloons;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;

  -- Transferência do Dia Laboratório aguardando quem recebeu confirmar.
  select * into v_balloon from public.lab_balloons
   where serial_key = lower(btrim(coalesce(p_serial, ''))) and status in ('pendente', 'aberto');
  if found and v_balloon.status = 'pendente' then
    raise exception 'lab_transfer_pending' using errcode = 'P0001';
  end if;

  v_os := public.current_os(p_serial);
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = v_os.id;

  if exists (select 1 from public.repair_stages
              where os_id = v_os.id and round = v_round and stage in ('desmontagem', 'avaliacao') and status <> 'concluida') then
    raise exception 'disassembly_open' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.repair_pt_requests where os_id = v_os.id and status = 'pendente') then
    raise exception 'pt_pending' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.repair_glass_jobs where os_id = v_os.id and status <> 'concluido') then
    raise exception 'in_glass' using errcode = 'P0001';
  end if;

  select * into v_stage from public.repair_stages where os_id = v_os.id and stage = 'manutencao' and round = v_round;
  if found then
    if v_stage.status <> 'concluida' then
      if not v_stage.legacy then
        raise exception 'in_repair' using errcode = 'P0001';
      end if;
      -- Checklist de um ativo retirado do técnico pelo supervisor: só segue com quem tem o balão do ativo agora.
      if not v_admin and (v_balloon.id is null or v_balloon.technician_id <> v_me)
         and exists (select 1 from public.lab_events e where e.kind = 'retirado' and e.detail ->> 'checklist' = v_stage.id::text) then
        raise exception 'lab_no_balloon' using errcode = 'P0001';
      end if;
      -- O ativo foi retirado com o checklist aberto e entregue de novo: quem tem o balão assume o checklist (com as marcações).
      if v_stage.technician_id is distinct from v_me and not v_admin and v_balloon.id is not null and v_balloon.technician_id = v_me then
        update public.repair_stages
           set technician_id = v_me, handover_from = v_stage.technician_id, handover_at = now(),
               handover_note = 'Ativo retirado do técnico anterior e entregue de novo no Dia Laboratório.'
         where id = v_stage.id
        returning * into v_stage;
      end if;
      if v_stage.technician_id is distinct from v_me and not v_admin then
        raise exception 'legacy_other_owner' using errcode = 'P0001',
          detail = coalesce(public.lab_name(v_stage.technician_id), 'outro técnico');
      end if;
      -- Checklist que já estava aberto: fica ligado ao balão do ativo (para fechar o balão ao finalizar).
      update public.lab_balloons set stage_id = v_stage.id
       where serial_key = v_os.serial_key and status in ('pendente', 'aberto') and stage_id is null;
      return v_stage.id;
    end if;
    v_round := v_round + 1;
  end if;

  -- O checklist é de quem bipou (o admin, abrindo o balão de outro técnico, abre para o dono do balão).
  insert into public.repair_stages (os_id, serial, stage, technician_id, round, legacy)
  values (v_os.id, v_os.serial, 'manutencao',
          case when v_admin and v_balloon.id is not null then v_balloon.technician_id else v_me end, v_round, true)
  returning * into v_stage;
  perform public.repair_log(v_os.id, v_stage.id, null, 'checklist_manutencao_iniciado');
  return v_stage.id;
end;
$$;

revoke all on function public.start_legacy_maintenance(text) from public, anon;
grant execute on function public.start_legacy_maintenance(text) to authenticated;
