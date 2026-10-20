-- Pesquisa por colaborador: além dos checklists de manutenção, traz quantas manutenções (itens) a pessoa
-- fez, o mesmo número do card "Manutenções feitas" (manutenção + trocas da desmontagem técnica).
-- Rode depois de 20261008000029_analysis_search.sql. Pode rodar de novo.

drop function if exists public.collaborator_summary(timestamptz, timestamptz);

create function public.collaborator_summary(
  p_from timestamptz default null,
  p_to timestamptz default null
) returns table (
  user_id uuid,
  name text,
  maintenance bigint,
  maintenance_items bigint,
  disassembly bigint,
  technical bigint,
  assembly bigint,
  quarantine bigint
)
language sql
stable
set search_path = ''
as $$
  with dev as (
    select d.user_id, d.kind, jsonb_array_length(d.maintenances) as items
    from public.devices d
    where d.phase = 'concluido'
      and (p_from is null or d.concluded_at >= p_from)
      and (p_to is null or d.concluded_at < p_to)
  ),
  quar as (
    select q.user_id, count(*) as n
    from public.quarantine_checks q
    where (p_from is null or q.created_at >= p_from)
      and (p_to is null or q.created_at < p_to)
    group by q.user_id
  )
  select p.id, coalesce(nullif(btrim(p.name), ''), p.email),
         count(*) filter (where dev.kind = 'manutencao'),
         coalesce(sum(dev.items) filter (where dev.kind in ('manutencao', 'desmontagem_tecnica')), 0)::bigint,
         count(*) filter (where dev.kind = 'desmontagem'),
         count(*) filter (where dev.kind = 'desmontagem_tecnica'),
         count(*) filter (where dev.kind = 'montagem'),
         coalesce(max(quar.n), 0)
  from public.profiles p
  left join dev on dev.user_id = p.id
  left join quar on quar.user_id = p.id
  group by p.id, p.name, p.email
  having count(dev.kind) > 0 or coalesce(max(quar.n), 0) > 0
  order by 2;
$$;

revoke all on function public.collaborator_summary(timestamptz, timestamptz) from public, anon;
grant execute on function public.collaborator_summary(timestamptz, timestamptz) to authenticated;
