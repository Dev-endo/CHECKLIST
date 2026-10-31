-- Lista dos balões da Análise: nova coluna com quantas vezes o ativo já foi reprovado na montagem
-- (em todo o histórico do serial). Rode depois de 20261008000032_sent_assembly_by_serial.sql.
-- Pode rodar de novo.

drop function if exists public.analysis_devices(text, timestamptz, timestamptz, uuid);

create function public.analysis_devices(
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
  pt_note text,
  assembly_rejections bigint
)
language sql
stable
set search_path = ''
as $$
  select * from (
    select d.kind, d.serial, coalesce(d.asset_short_id, a.asset_short_id) as unit, d.model, d.destination,
           d.status::text as status, coalesce(nullif(btrim(p.name), ''), p.email) as technician, d.concluded_at,
           d.notes, d.maintenances, d.faulty_parts as parts, d.failed_items as failures,
           d.consumption_note, d.pt_note,
           -- Quantas vezes este ativo (serial) já foi reprovado na montagem, em todo o histórico.
           (select count(*) from public.devices r
             where r.kind = 'montagem' and r.phase = 'concluido' and r.status = 'reprovado'
               and lower(btrim(r.serial)) = lower(btrim(d.serial)))::bigint as assembly_rejections
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
        -- Um aparelho por serial: o último evento dele no período foi um envio para a montagem (não foi
        -- reprovado depois na montagem).
        when 'sent_assembly' then d.id in (
          select e.id from (
            select distinct on (lower(btrim(x.serial))) x.id, x.kind
            from public.devices x
            where x.phase = 'concluido'
              and (p_from is null or x.concluded_at >= p_from)
              and (p_to is null or x.concluded_at < p_to)
              and ((x.kind in ('manutencao', 'desmontagem', 'desmontagem_tecnica')
                    and x.destination = 'montagem' and (p_user is null or x.user_id = p_user))
                   or (x.kind = 'montagem' and x.status = 'reprovado'))
            order by lower(btrim(x.serial)), x.concluded_at desc
          ) e where e.kind <> 'montagem')
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
           null::text, '[]'::jsonb, '[]'::jsonb, '{}'::text[], null::text, null::text, 0::bigint
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
