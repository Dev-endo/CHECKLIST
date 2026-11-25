-- Entrega de ativos: o supervisor (ou o admin) corrige o técnico de um ativo já vinculado. O balão passa para o técnico
-- escolhido (com o checklist em andamento e as marcações); a transferência pendente continua pendente, agora para ele.
-- Rode depois de 20261008000119_reprovados_direct.sql. Pode rodar de novo.
--
-- É uma correção: não conta como finalizado nem como transferido para quem estava com o ativo (sai da meta dele e entra
-- na de quem recebe). Fica no histórico como "responsavel_trocado" (por supervisor).

create or replace function public.lab_reassign(p_serials text[], p_technician uuid)
returns table (serial text, ok boolean, reason text, previous text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_serial text;
  b public.lab_balloons;
begin
  if not (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if not public.lab_is_technician(p_technician) then
    raise exception 'lab_technician_invalid' using errcode = 'P0001';
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
    if b.technician_id = p_technician then
      serial := v_serial; ok := false; reason := 'mesmo_tecnico'; previous := public.lab_name(b.technician_id);
      return next;
      continue;
    end if;

    -- Primeiro o balão; depois o checklist em andamento (o gatilho vê o balão já com o técnico novo).
    update public.lab_balloons
       set technician_id = p_technician,
           confirmed_at = case when status = 'aberto' then now() else confirmed_at end
     where id = b.id;
    update public.lab_assets set technician_id = p_technician, last_move_at = now() where id = b.asset_id;
    if b.status = 'aberto' and b.stage_id is not null then
      update public.repair_stages
         set technician_id = p_technician, handover_from = v_me, handover_at = now(),
             handover_note = 'Técnico corrigido pelo supervisor na Entrega de ativos.'
       where id = b.stage_id and status = 'em_andamento';
    end if;
    perform public.lab_log(b.asset_id, b.id, b.serial, 'responsavel_trocado', b.technician_id, p_technician,
      jsonb_build_object('por', 'supervisor', 'status', b.status));

    serial := v_serial; ok := true; reason := null; previous := public.lab_name(b.technician_id);
    return next;
  end loop;
end;
$$;

revoke all on function public.lab_reassign(text[], uuid) from public, anon;
grant execute on function public.lab_reassign(text[], uuid) to authenticated;
