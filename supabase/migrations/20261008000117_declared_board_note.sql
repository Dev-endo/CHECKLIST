-- Manutenções feitas: a "Placa" leva a observação do que foi feito (obs). Vale em qualquer checklist e destino, e vai
-- junto para o histórico da transferência. Rode depois de 20261008000116_glass_open_checklist.sql. Pode rodar de novo.
-- Corpo da migration 95 + obs (até 1000 letras; só quando escrita).

create or replace function public.declare_maintenance_items(p_stage_id uuid, p_items jsonb) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
  v_clean jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 40 then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'manutencao' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status = 'concluida' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object('nome', left(btrim(d.nome), 60), 'qtd', d.qtd)
           || case when nullif(btrim(coalesce(d.obs, '')), '') is not null
                   then jsonb_build_object('obs', left(btrim(d.obs), 1000)) else '{}'::jsonb end
           order by d.nome), '[]'::jsonb)
    into v_clean
    from jsonb_to_recordset(p_items) as d(nome text, qtd integer, obs text)
   where btrim(coalesce(d.nome, '')) <> '' and d.qtd between 1 and 99;

  update public.repair_stages set declared_items = v_clean where id = p_stage_id;
  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'manutencoes_informadas', jsonb_build_object('itens', v_clean));
end;
$$;

revoke all on function public.declare_maintenance_items(uuid, jsonb) from public, anon;
grant execute on function public.declare_maintenance_items(uuid, jsonb) to authenticated;
