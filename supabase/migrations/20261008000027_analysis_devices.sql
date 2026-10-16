-- Detalhe dos balões da Análise: ao clicar em um número, lista os aparelhos (unit id, serial, etapa,
-- responsável e observações) que o compõem, no mesmo período e colaborador dos filtros.
-- Rode depois de 20261008000026_awaiting_part.sql. Pode rodar de novo.
--
-- O unit id vem do checklist e, se ele não tiver sido preenchido ao bipar, da planilha de ativos pelo serial.
-- Cada linha é um checklist concluído (o mesmo serial pode aparecer mais de uma vez).

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

revoke all on function public.analysis_devices(text, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.analysis_devices(text, timestamptz, timestamptz, uuid) to authenticated;

-- Montagem: a lista de reprovados passa a completar o unit id pela planilha de ativos (pelo serial)
-- quando o checklist foi gravado sem ele.
create or replace function public.assembly_report(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_user uuid default null
) returns jsonb
language sql
stable
set search_path = ''
as $$
  with base as (
    select d.id, lower(btrim(d.serial)) as serial_key, d.serial, d.status, d.faulty_parts, d.failed_items,
           d.asset_short_id, d.source_device_id, d.user_id, d.concluded_at, d.destination, d.notes
    from public.devices d
    where d.kind = 'montagem'
      and d.phase = 'concluido'
      and (p_from is null or d.concluded_at >= p_from)
      and (p_to is null or d.concluded_at < p_to)
      and (p_user is null or d.user_id = p_user)
  ),
  quarantine as (
    select q.result
    from public.quarantine_checks q
    where (p_from is null or q.created_at >= p_from)
      and (p_to is null or q.created_at < p_to)
      and (p_user is null or q.user_id = p_user)
  ),
  parts as (
    select b.id, f ->> 'item' as part
    from base b, jsonb_array_elements(b.faulty_parts) as f
    where b.status = 'reprovado'
  )
  select jsonb_build_object(
    'checklists', (select count(*) from base),
    'released', (select count(distinct serial_key) from base where status = 'liberado'),
    -- Bloqueados: cada serial conta uma vez, não importa se foi marcado na manutenção, na desmontagem
    -- (normal ou técnica) ou enviado para bloqueio pela montagem.
    'released_block', (select count(distinct lower(btrim(a.serial)))
                       from public.devices a
                       where a.phase = 'concluido'
                         and (a.blocked or (a.kind = 'montagem' and a.status = 'liberado' and a.destination = 'bloqueio'))
                         and (p_from is null or a.concluded_at >= p_from)
                         and (p_to is null or a.concluded_at < p_to)
                         and (p_user is null or a.user_id = p_user)),
    'released_quarantine', (select count(distinct serial_key) from base where status = 'liberado' and destination = 'quarentena'),
    'rejected', (select count(*) from base where status = 'reprovado'),
    'returned_maintenance', (select count(distinct serial_key) from base
                              where status = 'reprovado' and destination = 'manutencao'),
    'returned_analysis', (select count(distinct serial_key) from base
                           where status = 'reprovado' and destination = 'analise'),
    'quarantine_approved', (select count(*) from quarantine where result = 'aprovado'),
    'quarantine_rejected', (select count(*) from quarantine where result = 'reprovado'),
    'by_assembler', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'released', released, 'rejected', rejected)
                       order by released desc, rejected desc, name)
      from (
        select coalesce(nullif(btrim(p.name), ''), p.email) as name,
               count(distinct b.serial_key) filter (where b.status = 'liberado') as released,
               count(*) filter (where b.status = 'reprovado') as rejected
        from base b
        join public.profiles p on p.id = b.user_id
        group by 1
      ) t
    ), '[]'::jsonb),
    'by_part', coalesce((
      select jsonb_agg(jsonb_build_object('part', part, 'count', n) order by n desc, part)
      from (select part, count(*) as n from parts group by part) t
    ), '[]'::jsonb),
    'rejections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'unit', r.asset_short_id,
        'serial', r.serial,
        'technician', r.technician,
        'assembler', r.assembler,
        'reasons', to_jsonb(r.failed_items),
        'parts', r.parts,
        'destination', r.destination,
        'note', r.notes
      ) order by r.concluded_at desc)
      from (
        select coalesce(b.asset_short_id, ast.asset_short_id) as asset_short_id, b.serial, b.failed_items,
               b.concluded_at, b.destination, b.notes,
               coalesce(nullif(btrim(pa.name), ''), pa.email) as assembler,
               coalesce(nullif(btrim(pt.name), ''), pt.email) as technician,
               coalesce((select jsonb_agg(f ->> 'item') from jsonb_array_elements(b.faulty_parts) as f), '[]'::jsonb) as parts
        from base b
        join public.profiles pa on pa.id = b.user_id
        left join public.assets ast on ast.serial_key = lower(btrim(b.serial))
        left join public.devices src on src.id = b.source_device_id
        left join public.profiles pt on pt.id = src.user_id
        where b.status = 'reprovado'
        order by b.concluded_at desc
        limit 200
      ) r
    ), '[]'::jsonb)
  );
$$;
