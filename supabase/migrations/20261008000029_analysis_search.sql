-- Pesquisas da Análise: por peça trocada (quem fez e em qual aparelho) e por colaborador
-- (o que cada pessoa concluiu em cada etapa). Rode depois de 20261008000028_maintenance_quarantine.sql.
-- Pode rodar de novo.

-- Lista dos aparelhos de um colaborador: todas as etapas (métrica all_stages).
create or replace function public.analysis_devices(
  p_metric text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_user uuid default null
) returns table (
  kind text,
  serial text,
  unit text,
  model text,
  destination text,
  status text,
  technician text,
  concluded_at timestamptz,
  notes text,
  maintenances jsonb,
  parts jsonb,
  failures text[],
  consumption_note text,
  pt_note text
)
language sql
stable
set search_path = ''
as $$
  select * from (
    select d.kind, d.serial, coalesce(d.asset_short_id, a.asset_short_id) as unit, d.model, d.destination,
           d.status::text as status, coalesce(nullif(btrim(p.name), ''), p.email) as technician, d.concluded_at,
           d.notes, d.maintenances, d.faulty_parts as parts, d.failed_items as failures,
           d.consumption_note, d.pt_note
    from public.devices d
    join public.profiles p on p.id = d.user_id
    left join public.assets a on a.serial_key = lower(btrim(d.serial))
    where d.phase = 'concluido'
      and (p_from is null or d.concluded_at >= p_from)
      and (p_to is null or d.concluded_at < p_to)
      and (p_user is null or d.user_id = p_user)
      and case p_metric
        when 'disassembled' then d.kind in ('desmontagem', 'desmontagem_tecnica')
        when 'dis_assembly' then d.kind in ('desmontagem', 'desmontagem_tecnica') and d.destination = 'montagem'
        when 'dis_maintenance' then d.kind in ('desmontagem', 'desmontagem_tecnica') and d.destination = 'manutencao'
        when 'dis_analysis' then d.kind in ('desmontagem', 'desmontagem_tecnica') and d.destination = 'analise'
        when 'dis_pt' then d.kind in ('desmontagem', 'desmontagem_tecnica') and d.destination = 'pt'
        when 'maintenance_items' then d.kind in ('manutencao', 'desmontagem_tecnica') and jsonb_array_length(d.maintenances) > 0
        when 'sent_assembly' then d.kind in ('manutencao', 'desmontagem', 'desmontagem_tecnica') and d.destination = 'montagem'
        when 'released_assembly' then d.kind = 'manutencao' and d.destination = 'montagem'
        when 'released_glass' then d.kind = 'manutencao' and d.destination = 'vidro'
        when 'awaiting_part' then d.destination = 'aguardando_peca'
        when 'released_resale' then d.kind = 'manutencao' and d.destination = 'montagem'
                                    and coalesce(d.resale, d.results ->> 'faceid' = 'fail')
        when 'sent_analysis' then d.destination = 'analise'
        when 'sent_pt' then d.destination = 'pt'
        when 'blocked' then d.blocked or (d.kind = 'montagem' and d.status = 'liberado' and d.destination = 'bloqueio')
        when 'blocked_maintenance' then d.kind = 'manutencao' and d.blocked
        when 'assembled' then d.kind = 'montagem'
        when 'assembly_approved' then d.kind = 'montagem' and d.status = 'liberado'
        when 'assembly_rejected' then d.kind = 'montagem' and d.status = 'reprovado'
        when 'assembly_analysis' then d.kind = 'montagem' and d.status = 'reprovado' and d.destination = 'analise'
        when 'assembly_maintenance' then d.kind = 'montagem' and d.status = 'reprovado' and d.destination = 'manutencao'
        when 'assembly_quarantine' then d.kind = 'montagem' and d.status = 'liberado' and d.destination = 'quarentena'
        when 'sent_quarantine' then d.destination = 'quarentena'
        when 'all_stages' then true
        else false
      end
    union all
    select 'quarentena', q.serial, coalesce(q.asset_short_id, a.asset_short_id), null::text, null::text,
           q.result, coalesce(nullif(btrim(p.name), ''), p.email), q.created_at,
           null::text, '[]'::jsonb, '[]'::jsonb, '{}'::text[], null::text, null::text
    from public.quarantine_checks q
    join public.profiles p on p.id = q.user_id
    left join public.assets a on a.serial_key = lower(btrim(q.serial))
    where p_metric in ('quarantine_approved', 'quarantine_rejected')
      and q.result = case p_metric when 'quarantine_approved' then 'aprovado' else 'reprovado' end
      and (p_from is null or q.created_at >= p_from)
      and (p_to is null or q.created_at < p_to)
      and (p_user is null or q.user_id = p_user)
  ) t
  order by t.concluded_at desc
  limit 1000;
$$;

-- Peças trocadas: uma linha por peça de cada checklist concluído de manutenção ou desmontagem técnica.
-- p_item vazio traz todas as peças.
create or replace function public.analysis_parts(
  p_item text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_user uuid default null
) returns table (
  kind text,
  serial text,
  unit text,
  model text,
  destination text,
  technician text,
  user_id uuid,
  concluded_at timestamptz,
  item text,
  detail text
)
language sql
stable
set search_path = ''
as $$
  select d.kind, d.serial, coalesce(d.asset_short_id, a.asset_short_id), d.model, d.destination,
         coalesce(nullif(btrim(p.name), ''), p.email), d.user_id, d.concluded_at,
         m ->> 'item', m ->> 'detail'
  from public.devices d
  cross join lateral jsonb_array_elements(d.maintenances) as m
  join public.profiles p on p.id = d.user_id
  left join public.assets a on a.serial_key = lower(btrim(d.serial))
  where d.kind in ('manutencao', 'desmontagem_tecnica')
    and d.phase = 'concluido'
    and (p_from is null or d.concluded_at >= p_from)
    and (p_to is null or d.concluded_at < p_to)
    and (p_user is null or d.user_id = p_user)
    and (nullif(btrim(p_item), '') is null or m ->> 'item' = p_item)
  order by d.concluded_at desc
  limit 2000;
$$;

revoke all on function public.analysis_parts(text, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.analysis_parts(text, timestamptz, timestamptz, uuid) to authenticated;

-- O que cada colaborador concluiu no período, por etapa (quem não fez nada fica de fora).
create or replace function public.collaborator_summary(
  p_from timestamptz default null,
  p_to timestamptz default null
) returns table (
  user_id uuid,
  name text,
  maintenance bigint,
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
    select d.user_id, d.kind
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
