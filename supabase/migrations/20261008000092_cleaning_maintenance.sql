-- Manutenção "Limpeza": o técnico marca que fez a limpeza. Conta como 1 manutenção para quem finaliza, somada às peças
-- trocadas (que continuam podendo ser pedidas); entra na lista de manutenções, na meta e na produtividade.
-- Rode depois de 20261008000091_glass_keep_checklist.sql. Pode rodar de novo.

alter table public.repair_stages add column if not exists cleaning boolean not null default false;

-- Liga/desliga a limpeza da etapa.
create or replace function public.set_maintenance_cleaning(p_stage_id uuid, p_cleaning boolean) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
begin
  if p_cleaning is null then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or v_stage.stage <> 'manutencao' or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status = 'concluida' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  update public.repair_stages set cleaning = p_cleaning where id = p_stage_id;
  perform public.repair_log(v_stage.os_id, p_stage_id, null, case when p_cleaning then 'limpeza_marcada' else 'limpeza_desmarcada' end);
end;
$$;

revoke all on function public.set_maintenance_cleaning(uuid, boolean) from public, anon;
grant execute on function public.set_maintenance_cleaning(uuid, boolean) to authenticated;

-- Manutenções de quem finaliza (corpo da migration 82) + a limpeza (1).
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
  from (select * from board union all select * from cleaning union all select * from parts) x
  where (select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]));
$$;

revoke all on function public.repair_maintenance_items(uuid) from public, anon;
grant execute on function public.repair_maintenance_items(uuid) to authenticated;

-- Texto das manutenções nas listas (corpo da migration 86) + "Limpeza".
create or replace function public.repair_items_text(p_items jsonb) returns text
language sql
immutable
set search_path = ''
as $$
  with items as (
    select i ->> 'tipo' as tipo, coalesce(i ->> 'peca', 'Peça') as peca, i ->> 'finalidade' as finalidade,
           coalesce((i ->> 'qtd')::integer, 1) as qtd, nullif(btrim(i ->> 'descricao'), '') as descricao
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i
  ),
  grouped as (
    select 1 as ord, 'Placa' || coalesce(' (' || descricao || ')', '') as txt from items where tipo = 'placa'
    union all
    select 1, 'Limpeza' from items where tipo = 'limpeza'
    union all
    select 2, peca || case when sum(qtd) > 1 then ' ×' || sum(qtd) else '' end
              || case when finalidade = 'teste' then ' (teste usada de vez)' else '' end
      from items where tipo is distinct from 'placa' and tipo is distinct from 'limpeza'
     group by peca, finalidade
  )
  select nullif(string_agg(txt, ', ' order by ord, txt), '') from grouped;
$$;

revoke all on function public.repair_items_text(jsonb) from public, anon;
grant execute on function public.repair_items_text(jsonb) to authenticated;
