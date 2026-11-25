-- Aba Reprovados: o supervisor (ou o admin) direciona os seriais bipados para um técnico; cada um vira um balão
-- ("Reprovado na quarentena (redistribuído)") no Checklist manutenção dele. Rode depois de
-- 20261008000118_goal_distinct_assets.sql. Pode rodar de novo.
--
-- Diferente da entrega (tudo ou nada), aqui cada serial tem o seu resultado: o que já está com um técnico (ou não existe
-- na planilha de ativos) é pulado e a tela mostra o motivo.

create or replace function public.lab_direct_rejected(p_serials text[], p_technician uuid)
returns table (serial text, ok boolean, reason text, holder text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_serial text;
  v_asset public.lab_assets;
  v_balloon uuid;
  v_holder uuid;
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
      serial := v_serial; ok := false; reason := 'nao_encontrado'; holder := null;
      return next;
      continue;
    end if;
    select b.technician_id into v_holder from public.lab_balloons b
     where b.serial_key = lower(v_serial) and b.status in ('pendente', 'aberto');
    if v_holder is not null then
      serial := v_serial; ok := false; reason := 'com_tecnico'; holder := public.lab_name(v_holder);
      v_holder := null;
      return next;
      continue;
    end if;

    v_asset := public.lab_open_passage(v_serial);
    v_balloon := public.lab_give(v_asset, p_technician, 'redistribuicao', v_me, 'Reprovado: direcionado pela aba Reprovados.');
    perform public.lab_log(v_asset.id, v_balloon, v_asset.serial, 'redistribuicao', v_me, p_technician,
      jsonb_build_object('por', 'reprovados', 'status_anterior', v_asset.status));
    serial := v_serial; ok := true; reason := null; holder := public.lab_name(p_technician);
    return next;
  end loop;
end;
$$;

revoke all on function public.lab_direct_rejected(text[], uuid) from public, anon;
grant execute on function public.lab_direct_rejected(text[], uuid) to authenticated;
