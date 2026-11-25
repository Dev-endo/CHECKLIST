-- Meta do técnico: ativo conta uma vez por serial e OS (o mesmo serial finalizado de novo com a mesma OS não vira outro
-- ativo; o trabalho entra em "manutenções feitas"). Rode depois de 20261008000117_declared_board_note.sql.
-- Pode rodar de novo.
--
--   * finalizados / transferidos / abertos / meta: serial + OS distintos (a OS do checklist do balão, ou a da passagem).
--   * manutencoes: as manutenções feitas informadas nos balões finalizados (e nas transferências) do dia.
--   * checklists: quantos balões ele fechou no dia (com repetição).

create or replace function public.lab_goal_count(p_user uuid, p_day date) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with w as (select public.lab_day_start(p_day) as t0, public.lab_day_start(p_day + 1) as t1),
  b as (
    select bl.id, bl.status, bl.confirmed_at, bl.finished_at, st.declared_items,
           bl.serial_key || '|' || coalesce(coalesce(st.os_id, a.os_id)::text, '') as k
      from public.lab_balloons bl
      join public.lab_assets a on a.id = bl.asset_id
      left join public.repair_stages st on st.id = bl.stage_id
     where bl.technician_id = p_user
  ),
  fin as (
    select b.* from b, w
     where b.status in ('finalizado', 'transferido') and b.finished_at >= w.t0 and b.finished_at < w.t1
  ),
  opn as (
    select b.* from b, w
     where b.confirmed_at < w.t1 and (b.finished_at is null or b.finished_at >= w.t1)
  ),
  -- Manutenções de cada balão fechado: as do checklist (finalizado) ou as guardadas na transferência.
  items as (
    select coalesce(
             case when f.status = 'transferido'
                  then (select e.detail -> 'manutencoes' from public.lab_events e
                         where e.kind = 'transferencia' and e.detail ->> 'balao_anterior' = f.id::text
                         order by e.created_at desc limit 1)
                  else f.declared_items end,
             '[]'::jsonb) as list
      from fin f
  )
  select jsonb_build_object(
    'finalizados', (select count(distinct k) from fin),
    'transferidos', (select count(distinct k) from fin where status = 'transferido'),
    'abertos', (select count(distinct k) from opn where k not in (select k from fin)),
    'meta', (select count(distinct k) from (select k from fin union select k from opn) u),
    'checklists', (select count(*) from fin),
    'manutencoes', (select coalesce(sum(coalesce((i ->> 'qtd')::integer, 1)), 0)
                      from items, jsonb_array_elements(case when jsonb_typeof(items.list) = 'array' then items.list else '[]'::jsonb end) i),
    'pendentes', (select count(*) from public.lab_balloons x where x.technician_id = p_user and x.status = 'pendente'));
$$;

revoke all on function public.lab_goal_count(uuid, date) from public, anon, authenticated;
