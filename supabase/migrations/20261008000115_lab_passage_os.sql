-- Dia Laboratório: a passagem do ativo é amarrada à OS. O mesmo serial só conta de novo no acompanhamento se tiver
-- outra OS. Rode depois de 20261008000114_quarantine_choice.sql. Pode rodar de novo.
--
--   * lab_assets.os_id: a OS da passagem (a atual do serial ao entrar, ou a do checklist aberto).
--   * lab_open_passage: o ativo que volta com a mesma OS reabre a passagem anterior (não cria outra).
--   * lab_board / lab_balloon_report devolvem o número da OS.

alter table public.lab_assets add column if not exists os_id uuid references public.service_orders (id) on delete set null;

-- Passagens antigas: a OS do último checklist do balão; sem checklist, a OS atual do serial na entrada.
update public.lab_assets a
   set os_id = (select st.os_id from public.lab_balloons b join public.repair_stages st on st.id = b.stage_id
                 where b.asset_id = a.id order by b.created_at desc limit 1)
 where a.os_id is null;
update public.lab_assets a
   set os_id = (select so.id from public.service_orders so
                 where so.serial_key = a.serial_key and so.created_at <= a.entered_at
                 order by so.created_at desc limit 1)
 where a.os_id is null;

-- A passagem aberta do ativo; sem ela, reabre a última com a mesma OS, ou abre uma nova.
create or replace function public.lab_open_passage(p_serial text) returns public.lab_assets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.lab_assets;
  v_key text := lower(btrim(coalesce(p_serial, '')));
  v_os uuid;
begin
  select so.id into v_os from public.service_orders so where so.serial_key = v_key order by so.created_at desc limit 1;

  select * into v from public.lab_assets where serial_key = v_key and exited_at is null for update;
  if found then
    if v.os_id is null and v_os is not null then
      update public.lab_assets set os_id = v_os where id = v.id returning * into v;
    end if;
    return v;
  end if;

  -- Voltou com a mesma OS: é a mesma passagem (não conta de novo).
  select * into v from public.lab_assets
   where serial_key = v_key and os_id is not distinct from v_os
   order by entered_at desc limit 1 for update;
  if found then
    update public.lab_assets set exited_at = null, last_move_at = now() where id = v.id returning * into v;
    perform public.lab_log(v.id, null, v.serial, 'reentrada', null, null, jsonb_build_object('status_anterior', v.status));
    return v;
  end if;

  insert into public.lab_assets (serial, unit_id, model, entered_by, os_id)
  select btrim(p_serial), a.asset_short_id, a.model, (select auth.uid()), v_os
    from (select 1) one
    left join lateral (select x.asset_short_id, x.model from public.assets x where x.serial_key = v_key limit 1) a on true
  returning * into v;
  perform public.lab_log(v.id, null, v.serial, 'entrada');
  return v;
end;
$$;

revoke all on function public.lab_open_passage(text) from public, anon, authenticated;

create or replace function public.lab_on_stage() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.lab_balloons;
  v_asset public.lab_assets;
  v_status text;
  v_id uuid;
  v_me uuid := coalesce((select auth.uid()), new.technician_id);
begin
  if new.stage <> 'manutencao' or not coalesce(new.legacy, false) then
    return null;
  end if;

  -- A passagem aberta do ativo fica com a OS do checklist (quando ainda não tinha).
  if new.status = 'em_andamento' then
    update public.lab_assets set os_id = new.os_id
     where serial_key = new.serial_key and exited_at is null and os_id is null;
  end if;

  -- Checklist da Análise técnica: sem balão. Ao finalizar, fecha a fila da análise, registra o reparo em placa (se
  -- houve) e move o ativo do Dia Laboratório para o destino.
  if coalesce(new.analysis, false) then
    if tg_op = 'UPDATE' and new.status = 'concluida' and old.status is distinct from 'concluida' then
      if new.board_note is not null then
        update public.repair_analysis_queue
           set status = 'concluida', result = 'reparo_placa', finished_by = v_me, finished_at = now(),
               board_status = 'concluido', board_by = new.technician_id, board_started_at = coalesce(board_started_at, now()),
               board_finished_at = now(), board_note = new.board_note,
               board_destination = case when new.outcome in ('quarentena', 'vidro') then new.outcome end
         where os_id = new.os_id;
        if not found then
          insert into public.repair_analysis_queue (os_id, stage_id, serial, failed_tests, status, result, started_by, started_at,
                                                    finished_by, finished_at, board_status, board_by, board_started_at,
                                                    board_finished_at, board_note, board_destination)
          values (new.os_id, new.id, new.serial, '[]'::jsonb, 'concluida', 'reparo_placa', new.technician_id, now(), v_me, now(),
                  'concluido', new.technician_id, now(), now(), new.board_note,
                  case when new.outcome in ('quarentena', 'vidro') then new.outcome end);
        end if;
        perform public.repair_log(new.os_id, new.id, null, 'reparo_placa_concluido',
          jsonb_build_object('observacao', new.board_note, 'destino', new.outcome, 'pela', 'analise_checklist'));
      else
        update public.repair_analysis_queue
           set status = 'concluida', finished_by = v_me, finished_at = now()
         where os_id = new.os_id and status <> 'concluida';
      end if;
      select * into v_asset from public.lab_assets
       where serial_key = new.serial_key and exited_at is null and status = 'analise'
       for update;
      if found and new.outcome is distinct from 'analise' then
        v_status := public.lab_status_for(new.outcome);
        update public.lab_assets
           set status = v_status, last_move_at = now(),
               exited_at = case when v_status in ('pt', 'revenda', 'bloqueado') then now() end
         where id = v_asset.id;
        perform public.lab_log(v_asset.id, null, v_asset.serial, 'analise_finalizada', new.technician_id, null,
          jsonb_build_object('destino', new.outcome, 'reparo_placa', new.board_note));
      end if;
    end if;
    return null;
  end if;

  if new.status = 'em_andamento'
     and (tg_op = 'INSERT' or old.status is distinct from new.status or old.technician_id is distinct from new.technician_id) then
    select * into b from public.lab_balloons where serial_key = new.serial_key and status in ('pendente', 'aberto') for update;
    if found then
      if b.status = 'aberto' then
        if b.stage_id is distinct from new.id then
          update public.lab_balloons set stage_id = new.id where id = b.id;
        end if;
        if b.technician_id <> new.technician_id then
          update public.lab_balloons set technician_id = new.technician_id, confirmed_at = now() where id = b.id;
          update public.lab_assets set technician_id = new.technician_id, last_move_at = now() where id = b.asset_id;
          perform public.lab_log(b.asset_id, b.id, b.serial, 'responsavel_trocado', b.technician_id, new.technician_id);
        end if;
      end if;
    else
      select a.* into v_asset from public.lab_assets a
       where a.serial_key = new.serial_key and a.status = 'pt' and a.exited_at is not null
         and exists (select 1 from public.lab_balloons x where x.asset_id = a.id and x.stage_id = new.id)
         and not exists (select 1 from public.lab_assets o where o.serial_key = new.serial_key and o.exited_at is null)
       order by a.entered_at desc limit 1 for update;
      if found then
        update public.lab_assets set exited_at = null where id = v_asset.id;
        perform public.lab_log(v_asset.id, null, v_asset.serial, 'pt_recusado');
      else
        v_asset := public.lab_open_passage(new.serial);
      end if;
      v_id := public.lab_give(v_asset, new.technician_id, 'retorno', null, null, false, new.id);
      perform public.lab_log(v_asset.id, v_id, v_asset.serial, 'retorno', null, new.technician_id,
        jsonb_build_object('status_anterior', v_asset.status));
    end if;

  elsif tg_op = 'UPDATE' and new.status = 'concluida' and old.status is distinct from 'concluida' then
    select * into b from public.lab_balloons where stage_id = new.id and status in ('pendente', 'aberto') for update;
    if found then
      if b.status = 'pendente' then
        raise exception 'lab_transfer_pending' using errcode = 'P0001';
      end if;
      v_status := public.lab_status_for(new.outcome);
      update public.lab_balloons set status = 'finalizado', outcome = new.outcome, finished_at = now() where id = b.id;
      update public.lab_assets
         set status = v_status, technician_id = null, last_technician_id = b.technician_id, last_move_at = now(),
             exited_at = case when v_status in ('pt', 'revenda', 'bloqueado') then now() end
       where id = b.asset_id;
      perform public.lab_log(b.asset_id, b.id, b.serial, 'finalizacao', b.technician_id, null,
        jsonb_build_object('destino', new.outcome, 'manutencoes', new.maintenance_items));
    end if;
  end if;
  return null;
end;
$$;

revoke all on function public.lab_on_stage() from public, anon, authenticated;

-- Acompanhamento com o número da OS (corpo da migration 108 + os_number).
drop function if exists public.lab_board(timestamptz, timestamptz);
create or replace function public.lab_board(p_from timestamptz, p_to timestamptz)
returns table (id uuid, serial text, unit text, model text, status text, technician_id uuid, technician text,
               last_technician text, entered_at timestamptz, exited_at timestamptz, rejected_at timestamptz,
               last_move_at timestamptz, os_number text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return query
    select a.id, a.serial, a.unit_id, a.model, a.status, a.technician_id, public.lab_name(a.technician_id),
           public.lab_name(a.last_technician_id), a.entered_at, a.exited_at, a.rejected_at, a.last_move_at,
           (select so.os_number from public.service_orders so where so.id = a.os_id)
      from public.lab_assets a
     where a.exited_at is null
        or (a.entered_at >= p_from and a.entered_at < p_to)
        or (a.exited_at >= p_from and a.exited_at < p_to)
        or (a.rejected_at >= p_from and a.rejected_at < p_to)
     order by a.last_move_at desc
     limit 5000;
end;
$$;

revoke all on function public.lab_board(timestamptz, timestamptz) from public, anon;
grant execute on function public.lab_board(timestamptz, timestamptz) to authenticated;

drop function if exists public.lab_balloon_report(timestamptz, timestamptz);
create or replace function public.lab_balloon_report(p_from timestamptz, p_to timestamptz)
returns table (id uuid, asset_id uuid, serial text, unit text, technician_id uuid, technician text, status text,
               source text, from_name text, transferred_to text, outcome text, created_at timestamptz,
               confirmed_at timestamptz, finished_at timestamptz, os_number text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return query
    select b.id, b.asset_id, b.serial, a.unit_id, b.technician_id, public.lab_name(b.technician_id), b.status, b.source,
           public.lab_name(b.from_id), public.lab_name(b.transferred_to), b.outcome, b.created_at, b.confirmed_at,
           b.finished_at,
           (select so.os_number from public.service_orders so
             where so.id = coalesce((select st.os_id from public.repair_stages st where st.id = b.stage_id), a.os_id))
      from public.lab_balloons b
      join public.lab_assets a on a.id = b.asset_id
     where b.created_at < p_to and (b.finished_at is null or b.finished_at >= p_from)
     order by b.created_at desc
     limit 5000;
end;
$$;

revoke all on function public.lab_balloon_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.lab_balloon_report(timestamptz, timestamptz) to authenticated;
