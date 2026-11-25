-- Diagnóstico de um serial no Dia Laboratório (só leitura). Troque o serial na primeira linha e rode no SQL Editor.
with p as (select lower(btrim('SPV6QM96LXF')) as k)
select 'passagem' as o_que, a.status as status, a.entered_at as quando, a.exited_at::text as extra,
       (select so.os_number from public.service_orders so where so.id = a.os_id) as os, public.lab_name(a.technician_id) as tecnico
  from public.lab_assets a, p where a.serial_key = p.k
union all
select 'balao', b.status || coalesce(' / ' || b.outcome, ''), b.created_at, b.finished_at::text,
       coalesce(b.stage_id::text, 'sem checklist ligado'), public.lab_name(b.technician_id) || ' (' || b.source || ')'
  from public.lab_balloons b, p where b.serial_key = p.k
union all
select 'checklist', st.status || coalesce(' / ' || st.outcome, '') || case when st.legacy then '' else ' (Reparo)' end
       || case when coalesce(st.analysis, false) then ' (análise)' else '' end,
       st.started_at, st.finished_at::text, st.id::text || ' rodada ' || st.round, public.lab_name(st.technician_id)
  from public.repair_stages st, p where st.serial_key = p.k and st.stage = 'manutencao'
union all
select 'vidro', g.status, g.created_at, g.finished_at::text, g.origin, public.lab_name(g.responsible_id)
  from public.repair_glass_jobs g, p where g.serial_key = p.k
union all
select 'evento lab: ' || e.kind, coalesce(e.detail ->> 'destino', ''), e.created_at, null, null, public.lab_name(e.actor_id)
  from public.lab_events e, p where e.serial_key = p.k
union all
select 'evento reparo: ' || ev.action, coalesce(ev.detail ->> 'destino', ''), ev.created_at, null, ev.stage_id::text, null
  from public.repair_events ev
  join public.repair_stages st on st.id = ev.stage_id, p
 where st.serial_key = p.k
order by quando;
