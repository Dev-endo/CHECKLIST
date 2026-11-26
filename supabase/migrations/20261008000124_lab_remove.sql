-- Acompanhamento > Por técnico: o supervisor (ou o admin) retira o ativo do técnico sem transferir para ninguém.
-- Rode depois de 20261008000123_quarantine_conference.sql. Pode rodar de novo.
--
-- É uma correção (ativo entregue por engano): o balão some, não conta como finalizado nem como transferido e sai da
-- meta e da bancada do técnico.
--   * Entregue pelo supervisor numa passagem nova (sem outro balão): a passagem é apagada, então o ativo também sai de
--     "Entraram" e de "Ainda no laboratório".
--   * Nos outros casos (veio do Vidro, reprovado redistribuído, transferência, retorno, passagem com histórico): a
--     passagem fica e o ativo volta para onde estava (Vidro, Reprovado aguardando redistribuição ou Aguardando
--     manutenção sem técnico).
--   * Checklist já aberto pelo técnico: não retira (o técnico finaliza, ou o supervisor troca o responsável).
-- O histórico do serial fica, com o movimento "retirado".

create or replace function public.lab_remove(p_serials text[])
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
    if b.stage_id is not null and exists (select 1 from public.repair_stages st where st.id = b.stage_id and st.status = 'em_andamento') then
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
                         'passagem', case when v_drop then 'apagada' else 'mantida' end));
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

revoke all on function public.lab_remove(text[]) from public, anon;
grant execute on function public.lab_remove(text[]) to authenticated;
