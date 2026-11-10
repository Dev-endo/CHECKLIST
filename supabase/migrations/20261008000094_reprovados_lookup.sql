-- Aba Reprovados: bipa vários seriais e vê quem teve a mão em cada aparelho (só leitura).
-- Rode depois de 20261008000093_daily_goal_10.sql. Pode rodar de novo.
--
-- Por serial, na OS mais recente do aparelho e na manutenção mais recente dela:
--   responsavel  = técnico dono da manutenção;
--   desmontagem  = técnico da desmontagem (rodada mais recente);
--   checklist    = quem marcou por último o checklist (fechado; se não houver, o aberto);
--   manutencao   = técnico da manutenção (e, se houve, quem fez o reparo em placa vem em `placa`);
--   montagem     = quem rodou o cronômetro de montagem (todos, sem repetir);
--   feitas       = as manutenções contadas na manutenção (peças, placa, limpeza...) e o total (feitas_qtd).
-- Mais o destino e a data de finalização da manutenção e o último resultado da quarentena.

drop function if exists public.reprovados_lookup(text[]);

create or replace function public.reprovados_lookup(p_serials text[])
returns table (
  serial text, os_number text, outcome text, finished_at timestamptz,
  responsavel text, desmontagem text, checklist text, manutencao text, placa text, montagem text,
  quarentena text, quarentena_por text, quarentena_em timestamptz, feitas text, feitas_qtd integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with wanted as (
    select distinct on (lower(btrim(s))) btrim(s) as serial, lower(btrim(s)) as key
      from unnest(coalesce(p_serials, '{}')) s
     where btrim(coalesce(s, '')) <> ''
     limit 500
  ),
  base as (
    select w.serial, w.key, o.id as os_id, o.os_number,
           m.id as maint_id, m.technician_id as maint_tech, m.outcome, m.finished_at,
           m.maintenance_items, m.maintenance_count
      from wanted w
      left join lateral (
        select * from public.service_orders x where x.serial_key = w.key order by x.created_at desc limit 1
      ) o on true
      left join lateral (
        select * from public.repair_stages s where s.os_id = o.id and s.stage = 'manutencao' order by s.round desc limit 1
      ) m on true
  ),
  who(id, name) as (
    select p.id, coalesce(nullif(btrim(p.name), ''), p.email) from public.profiles p
  )
  select b.serial, b.os_number, b.outcome, b.finished_at,
         (select name from who where id = b.maint_tech),
         (select name from public.repair_stages d join who on who.id = d.technician_id
           where d.os_id = b.os_id and d.stage = 'desmontagem' order by d.round desc limit 1),
         (select name from public.repair_checklist_results c join who on who.id = c.updated_by
           where c.stage_id = b.maint_id order by (c.phase = 'fechado') desc, c.updated_at desc limit 1),
         (select name from who where id = b.maint_tech),
         (select name from public.repair_analysis_queue q join who on who.id = q.board_by
           where q.os_id = b.os_id and q.board_status = 'concluido' limit 1),
         (select string_agg(distinct who.name, ', ' order by who.name)
            from public.repair_timer_sessions t join who on who.id = t.user_id
           where t.stage_id in (select s.id from public.repair_stages s where s.os_id = b.os_id and s.stage = 'manutencao')
             and t.phase = 'montagem'),
         (select qc.result from public.quarantine_checks qc where lower(btrim(qc.serial)) = b.key order by qc.created_at desc limit 1),
         (select name from public.quarantine_checks qc join who on who.id = qc.user_id
           where lower(btrim(qc.serial)) = b.key order by qc.created_at desc limit 1),
         (select qc.created_at from public.quarantine_checks qc where lower(btrim(qc.serial)) = b.key order by qc.created_at desc limit 1),
         public.repair_items_text(b.maintenance_items), b.maintenance_count
    from base b
   where (select public.has_any_role(
     array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]));
$$;

revoke all on function public.reprovados_lookup(text[]) from public, anon;
grant execute on function public.reprovados_lookup(text[]) to authenticated;
