-- Checklist manutenção: abrir direto ao bipar o serial.
-- Rode depois de 20261008000073_legacy_maintenance_checklist.sql. Pode rodar de novo.
--
-- Mudanças em start_legacy_maintenance:
--   * se a OS do aparelho já teve um checklist finalizado, abre um checklist novo (nova rodada) na mesma OS, em vez de
--     pedir uma OS nova;
--   * se o aparelho está no fluxo do Reparo (Estágio 1 ou manutenção do Estágio 2 em andamento), não abre aqui;
--   * se o aparelho está no Vidro, não abre (o checklist volta para o técnico quando o vidro terminar).

create or replace function public.start_legacy_maintenance(p_serial text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_round integer;
  v_stage public.repair_stages;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  v_os := public.current_os(p_serial);
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = v_os.id;

  if exists (select 1 from public.repair_stages
              where os_id = v_os.id and round = v_round and stage in ('desmontagem', 'avaliacao') and status <> 'concluida') then
    raise exception 'disassembly_open' using errcode = 'P0001';
  end if;
  -- No Vidro: o checklist volta sozinho para o técnico quando o vidro terminar (não abre um novo).
  if exists (select 1 from public.repair_glass_jobs where os_id = v_os.id and status <> 'concluido') then
    raise exception 'in_glass' using errcode = 'P0001';
  end if;

  select * into v_stage from public.repair_stages where os_id = v_os.id and stage = 'manutencao' and round = v_round;
  if found then
    if v_stage.status <> 'concluida' then
      if not v_stage.legacy then
        -- Manutenção do Estágio 2 em andamento: o aparelho está no Reparo.
        raise exception 'in_repair' using errcode = 'P0001';
      end if;
      return v_stage.id;
    end if;
    -- Já foi checado nesta OS: um checklist novo, na rodada seguinte (o anterior fica no histórico).
    v_round := v_round + 1;
  end if;

  insert into public.repair_stages (os_id, serial, stage, technician_id, round, legacy)
  values (v_os.id, v_os.serial, 'manutencao', (select auth.uid()), v_round, true)
  returning * into v_stage;
  perform public.repair_log(v_os.id, v_stage.id, null, 'checklist_manutencao_iniciado');
  return v_stage.id;
end;
$$;

revoke all on function public.start_legacy_maintenance(text) from public, anon;
grant execute on function public.start_legacy_maintenance(text) to authenticated;
