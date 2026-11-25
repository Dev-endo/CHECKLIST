-- Checklist manutenção sem trava de balão: o técnico bipa o serial e o checklist abre, como antes do Dia Laboratório.
-- Rode depois de 20261008000109_analysis_checklist.sql. Pode rodar de novo.
--
-- A migration 108 fez o start_legacy_maintenance exigir o balão do técnico (lab_no_balloon). No site oficial ainda não
-- há balões, então o checklist não abria e a tela ficava em "Bipe o serial do aparelho". Aqui volta o corpo da
-- migration 88: o checklist é de quem bipou. Se o ativo tiver um balão aberto de outro técnico, o gatilho lab_on_stage
-- passa o balão para quem abriu. Só a transferência pendente do Dia Laboratório continua segurando.
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
      if v_stage.technician_id is distinct from v_me and not v_admin then
        raise exception 'legacy_other_owner' using errcode = 'P0001',
          detail = coalesce(public.lab_name(v_stage.technician_id), 'outro técnico');
      end if;
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
