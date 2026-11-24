-- Análise: reprovados na quarentena do período, com os responsáveis do último checklist e quando foi reprovado.
-- Rode depois de 20261008000102_incorrect_defect.sql (usa reprovados_lookup, da 94). Pode rodar de novo.
--
-- Um aparelho por linha (o serial uma vez), com a reprovação mais recente dentro do período. Os responsáveis são os da
-- OS mais recente do aparelho (como na aba Reprovados): responsável, desmontagem, checklist, manutenção, montagem e as
-- manutenções feitas. `vezes` = quantas vezes o serial foi reprovado no período. Só admin e supervisor.

create or replace function public.repair_dashboard_reprovados(p_from date, p_to date)
returns table (
  serial text, os_number text, model text, reprovado_em timestamptz, reprovado_por text, vezes integer,
  responsavel text, desmontagem text, checklist text, manutencao text, montagem text, feitas text, feitas_qtd integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select (p_from::timestamp at time zone 'America/Sao_Paulo') as t0,
           ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo') as t1
  ),
  rp as (
    select distinct on (lower(btrim(q.serial)))
           btrim(q.serial) as serial, lower(btrim(q.serial)) as key, q.created_at as at, q.user_id,
           count(*) over (partition by lower(btrim(q.serial)))::int as vezes
      from public.quarantine_checks q, w
     where q.result = 'reprovado' and q.created_at >= w.t0 and q.created_at < w.t1
     order by lower(btrim(q.serial)), q.created_at desc
  )
  select r.serial, l.os_number, a.model, r.at,
         (select coalesce(nullif(btrim(p.name), ''), p.email) from public.profiles p where p.id = r.user_id),
         r.vezes, l.responsavel, l.desmontagem, l.checklist, l.manutencao, l.montagem, l.feitas, l.feitas_qtd
    from rp r
    cross join lateral public.reprovados_lookup(array[r.serial]) l
    left join public.assets a on a.serial_key = r.key
   where (select public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
   order by r.at desc
   limit 500;
$$;

revoke all on function public.repair_dashboard_reprovados(date, date) from public, anon;
grant execute on function public.repair_dashboard_reprovados(date, date) to authenticated;
