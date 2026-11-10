-- Checklist manutenção: ao finalizar, o técnico informa as manutenções que fez no aparelho (peças trocadas, placa,
-- limpeza...). Elas são contadas como manutenções de quem finaliza (meta, produtividade) e ficam gravadas na etapa,
-- então a aba Reprovados mostra quem fez o quê.
-- Rode depois de 20261008000094_reprovados_lookup.sql. Pode rodar de novo.
--
-- declare_maintenance_items(p_stage_id, p_items): p_items = [{"nome": "Bateria", "qtd": 1}, ...]. Troca a lista da etapa
-- (lista vazia = nenhuma manutenção). Só o dono da etapa (ou o admin), com a etapa em andamento.
-- finish_maintenance já soma repair_maintenance_items na contagem: aqui a lista declarada entra nessa conta.

alter table public.repair_stages add column if not exists declared_items jsonb not null default '[]'::jsonb;

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

  select coalesce(jsonb_agg(jsonb_build_object('nome', left(btrim(d.nome), 60), 'qtd', d.qtd) order by d.nome), '[]'::jsonb)
    into v_clean
    from jsonb_to_recordset(p_items) as d(nome text, qtd integer)
   where btrim(coalesce(d.nome, '')) <> '' and d.qtd between 1 and 99;

  update public.repair_stages set declared_items = v_clean where id = p_stage_id;
  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'manutencoes_informadas', jsonb_build_object('itens', v_clean));
end;
$$;

revoke all on function public.declare_maintenance_items(uuid, jsonb) from public, anon;
grant execute on function public.declare_maintenance_items(uuid, jsonb) to authenticated;

-- Manutenções de quem finaliza (corpo da migration 92) + as informadas pelo técnico.
create or replace function public.repair_maintenance_items(p_stage_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with st as (
    select * from public.repair_stages where id = p_stage_id
  ),
  same_round as (
    select r.id from public.repair_stages r, st where r.os_id = st.os_id and r.round = st.round
  ),
  board as (
    select 1 as ord, 'Placa' as nome,
           jsonb_build_object('tipo', 'placa', 'descricao', q.board_note) as item
    from public.repair_analysis_queue q, st
    where q.os_id = st.os_id
      and q.board_status = 'concluido'
      and q.board_by = st.technician_id
      and q.stage_id in (select id from same_round)
  ),
  cleaning as (
    select 1 as ord, 'Limpeza' as nome, jsonb_build_object('tipo', 'limpeza', 'qtd', 1) as item
    from st where st.cleaning
  ),
  declared as (
    select 2 as ord, d.nome as nome, jsonb_build_object('tipo', 'feita', 'peca', d.nome, 'qtd', d.qtd) as item
    from st, jsonb_to_recordset(st.declared_items) as d(nome text, qtd integer)
  ),
  parts as (
    select 2 as ord, r.part as nome,
           jsonb_build_object('tipo', 'peca', 'peca', r.part,
             'qtd', case when r.purpose = 'teste' then 1
                         else r.qty_delivered - coalesce((select sum(t.qty) from public.stock_returns t
                                                           where t.request_id = r.id and t.reason = 'substituicao_defeito'), 0) end,
             'finalidade', r.purpose) as item
    from public.stock_requests r
    where r.stage_id in (select id from same_round)
      and not r.glass
      and (
        (r.purpose = 'definitiva'
          and r.qty_delivered - coalesce((select sum(t.qty) from public.stock_returns t
                                          where t.request_id = r.id and t.reason = 'substituicao_defeito'), 0) > 0)
        or (r.purpose = 'teste' and r.test_destiny = 'utilizacao_definitiva')
      )
  )
  select coalesce(jsonb_agg(x.item order by x.ord, x.nome), '[]'::jsonb)
  from (select * from board union all select * from cleaning union all select * from declared union all select * from parts) x
  where (select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]));
$$;

revoke all on function public.repair_maintenance_items(uuid) from public, anon;
grant execute on function public.repair_maintenance_items(uuid) to authenticated;
