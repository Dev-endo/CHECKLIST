-- Dia Laboratório: o aparelho que está no vidro (serviço de vidro aberto) conta como "em Vidro", mesmo que tenha ido
-- para o vidro antes de ser entregue. Antes, entregar esse serial criava um balão comum: o ativo ficava na bancada do
-- técnico enquanto estava no vidro e voltava sozinho quando o vidro terminava. Rode depois de
-- 20261008000121_link_open_checklist.sql. Pode rodar de novo.
--
--   * lab_in_glass: o serial tem um serviço de vidro aberto.
--   * lab_preview: mostra "vidro" para esse serial (a Entrega avisa "No Vidro: será direcionado").
--   * lab_deliver: entrega desse serial = direcionamento do Vidro (fecha o serviço de vidro e cria o balão "Direcionado
--     do Vidro" para o técnico escolhido).
--   * lab_direct_from_glass: aceita esse serial (a aba Vidro e a Entrega direcionam).
--   * lab_glass_serials: na aba Vidro, o serviço aberto de um ativo do Dia Laboratório mostra "Direcionar para técnico"
--     (não "Entregar ao responsável").

create or replace function public.lab_in_glass(p_serial text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.repair_glass_jobs g
                  where g.serial_key = lower(btrim(coalesce(p_serial, ''))) and g.status <> 'concluido');
$$;

revoke all on function public.lab_in_glass(text) from public, anon, authenticated;

create or replace function public.lab_preview(p_serials text[])
returns table (serial text, found boolean, unit text, model text, lab_status text, holder text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_any_role(array['admin', 'supervisor', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return query
    select s.v, a.serial_key is not null, a.asset_short_id, a.model,
           case when public.lab_in_glass(s.v) then 'vidro' else la.status end,
           (select public.lab_name(b.technician_id)
              from public.lab_balloons b where b.serial_key = lower(btrim(s.v)) and b.status in ('pendente', 'aberto'))
      from unnest(coalesce(p_serials, '{}')) with ordinality s(v, ord)
      left join lateral (select x.serial_key, x.asset_short_id, x.model from public.assets x
                          where x.serial_key = lower(btrim(s.v)) limit 1) a on true
      left join public.lab_assets la on la.serial_key = lower(btrim(s.v)) and la.exited_at is null
     order by s.ord;
end;
$$;

revoke all on function public.lab_preview(text[]) from public, anon;
grant execute on function public.lab_preview(text[]) to authenticated;

create or replace function public.lab_deliver(p_serials text[], p_technician uuid) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_serial text;
  v_asset public.lab_assets;
  v_balloon uuid;
  v_source text;
  v_glass jsonb;
  v_count integer := 0;
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
    if not exists (select 1 from public.assets a where a.serial_key = lower(v_serial)) then
      raise exception 'lab_serial_not_found' using errcode = 'P0001', detail = v_serial;
    end if;
    if exists (select 1 from public.lab_balloons b where b.serial_key = lower(v_serial) and b.status in ('pendente', 'aberto')) then
      raise exception 'lab_serial_taken' using errcode = 'P0001', detail = v_serial;
    end if;

    v_asset := public.lab_open_passage(v_serial);
    v_glass := null;
    -- No Vidro (status da passagem ou serviço de vidro aberto): é direcionado (fecha o serviço de vidro).
    v_source := case
      when v_asset.status = 'vidro' or public.lab_in_glass(v_serial) then 'vidro'
      when v_asset.status = 'reprovado_aguardando' then 'redistribuicao'
      else 'entrega' end;
    if v_source = 'vidro' then
      v_glass := public.lab_close_glass(v_serial, false);
    end if;
    v_balloon := public.lab_give(v_asset, p_technician, v_source, v_me);
    perform public.lab_log(v_asset.id, v_balloon, v_asset.serial,
      case v_source when 'vidro' then 'direcionamento_vidro' when 'redistribuicao' then 'redistribuicao' else 'entrega' end,
      v_me, p_technician, jsonb_build_object('status_anterior', v_asset.status, 'vidro', v_glass, 'por', 'supervisor'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.lab_deliver(text[], uuid) from public, anon;
grant execute on function public.lab_deliver(text[], uuid) to authenticated;

create or replace function public.lab_direct_from_glass(p_serials text[], p_technician uuid, p_display boolean default false)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_serial text;
  v_asset public.lab_assets;
  v_balloon uuid;
  v_glass jsonb;
  v_count integer := 0;
  v_by text;
begin
  if not (select public.has_any_role(array['admin', 'supervisor', 'tecnico_vidro']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if not public.lab_is_technician(p_technician) then
    raise exception 'lab_technician_invalid' using errcode = 'P0001';
  end if;
  if coalesce(array_length(p_serials, 1), 0) = 0 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  v_by := case when (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then 'supervisor' else 'tecnico_vidro' end;

  for v_serial in
    select min(btrim(s)) from unnest(p_serials) s where btrim(coalesce(s, '')) <> '' group by lower(btrim(s))
  loop
    -- Em Vidro: a passagem está em Vidro ou o aparelho tem um serviço de vidro aberto (ex.: enviado antes da entrega).
    select * into v_asset from public.lab_assets where serial_key = lower(v_serial) and exited_at is null for update;
    if not ((found and v_asset.status = 'vidro') or public.lab_in_glass(v_serial)) then
      raise exception 'lab_not_in_glass' using errcode = 'P0001', detail = v_serial;
    end if;
    if exists (select 1 from public.lab_balloons x where x.serial_key = lower(v_serial) and x.status in ('pendente', 'aberto')) then
      raise exception 'lab_serial_taken' using errcode = 'P0001', detail = v_serial;
    end if;
    v_asset := public.lab_open_passage(v_serial);
    v_glass := public.lab_close_glass(v_serial, p_display);
    v_balloon := public.lab_give(v_asset, p_technician, 'vidro', v_me,
      case when coalesce(p_display, false) then 'Troca de display solicitada pelo técnico de vidro.' end);
    perform public.lab_log(v_asset.id, v_balloon, v_asset.serial, 'direcionamento_vidro', v_me, p_technician,
      jsonb_build_object('por', v_by, 'vidro', v_glass, 'display_solicitado', coalesce(p_display, false)));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.lab_direct_from_glass(text[], uuid, boolean) from public, anon;
grant execute on function public.lab_direct_from_glass(text[], uuid, boolean) to authenticated;

create or replace function public.lab_glass_serials() returns table (serial text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.serial from public.lab_assets a
   where a.status = 'vidro' and a.exited_at is null
     and (select public.has_any_role(array['admin', 'supervisor', 'tecnico_vidro']::public.user_role[]))
  union
  -- Serviço de vidro aberto de um ativo com balão ou passagem do Dia Laboratório: também é direcionado (não volta sozinho).
  select g.serial from public.repair_glass_jobs g
   where g.status <> 'concluido'
     and exists (select 1 from public.lab_assets a where a.serial_key = g.serial_key and a.exited_at is null)
     and (select public.has_any_role(array['admin', 'supervisor', 'tecnico_vidro']::public.user_role[]));
$$;

revoke all on function public.lab_glass_serials() from public, anon;
grant execute on function public.lab_glass_serials() to authenticated;
