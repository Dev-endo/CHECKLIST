-- Checklist manutenção começado por outro técnico: "Checklist iniciado por Fulano. Fazer um novo?"
-- Rode depois de 20261008000087_resale_out_of_analysis.sql. Pode rodar de novo.
--
-- Problema: bipar o serial abre (ou retoma) o checklist do aparelho. Se ele tinha sido começado por outra pessoa, o
-- checklist abria, mas as marcações não salvavam e "Finalizar" dava "Seu perfil não pode fazer isso" (só o dono
-- grava). Agora:
--   * start_legacy_maintenance avisa (legacy_other_owner, com o nome de quem começou no detail);
--   * a tela pergunta "Fazer um novo?". Sim: take_legacy_checklist passa o checklist para quem bipou e começa do zero
--     (as marcações anteriores ficam guardadas no histórico). Não: nada muda, o checklist continua com o dono.

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
  -- PT aguardando aprovação: não abre outro checklist enquanto ninguém decidir.
  if exists (select 1 from public.repair_pt_requests where os_id = v_os.id and status = 'pendente') then
    raise exception 'pt_pending' using errcode = 'P0001';
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
      -- Começado por outro técnico: a tela pergunta "Fazer um novo?" (take_legacy_checklist). O nome vai no detail.
      if v_stage.technician_id is distinct from (select auth.uid())
         and not (select public.has_any_role(array['admin']::public.user_role[])) then
        raise exception 'legacy_other_owner' using errcode = 'P0001',
          detail = coalesce((select coalesce(nullif(btrim(p.name), ''), p.email) from public.profiles p where p.id = v_stage.technician_id), 'outro técnico');
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

-- "Sim, fazer um novo": o checklist em andamento passa para quem bipou, em branco.
create or replace function public.take_legacy_checklist(p_serial text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_round integer;
  v_stage public.repair_stages;
  v_old jsonb;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  v_os := public.current_os(p_serial);
  select coalesce(max(round), 1) into v_round from public.repair_stages where os_id = v_os.id;
  select * into v_stage from public.repair_stages
   where os_id = v_os.id and stage = 'manutencao' and round = v_round and legacy and status = 'em_andamento'
   for update;
  if not found then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  if v_stage.technician_id = (select auth.uid()) then
    return v_stage.id;
  end if;

  select coalesce(jsonb_object_agg(phase, results), '{}'::jsonb) into v_old
    from public.repair_checklist_results where stage_id = v_stage.id;
  delete from public.repair_checklist_results where stage_id = v_stage.id;
  update public.repair_stages set technician_id = (select auth.uid()), started_at = now() where id = v_stage.id;
  perform public.repair_log(v_os.id, v_stage.id, null, 'checklist_manutencao_assumido',
    jsonb_build_object('tecnico_anterior', v_stage.technician_id, 'marcacoes_anteriores', v_old));
  return v_stage.id;
end;
$$;

revoke all on function public.take_legacy_checklist(text) from public, anon;
grant execute on function public.take_legacy_checklist(text) to authenticated;
