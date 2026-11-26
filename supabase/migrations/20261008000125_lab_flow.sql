-- Acompanhamento > Operação no período: os eventos do período, um por linha, para os grupos Entradas, Saídas do
-- laboratório, Quarentena e a "Situação atual dos ativos que entraram". Rode depois de 20261008000124_lab_remove.sql.
-- Pode rodar de novo.
--
--   kind = 'entrega'     supervisor → técnico (balão com origem entrega), data = criação do balão.
--   kind = 'vidro'       Vidro → técnico (balão com origem vidro), data = criação do balão.
--   kind = 'retorno'     voltou para o técnico: reprovado na quarentena redistribuído ou retorno (ex.: PT recusado).
--   kind = 'saida'       finalização com destino PT, Bloqueado ou Revenda (result = destino), data = finalização.
--                        PT recusado depois não conta.
--   kind = 'quarentena'  envio para a quarentena pela manutenção (mesma fonte da lista Aguardando), data = envio,
--                        desde 1 dia antes do período (o card "Foram para quarentena ontem"). result / result_at = o
--                        primeiro resultado (aprovado ou reprovado) depois do envio. Retirados na conferência sem
--                        resultado não contam.
--   current_status: onde o ativo está agora (a passagem mais recente do serial no laboratório).

create or replace function public.lab_flow(p_from timestamptz, p_to timestamptz)
returns table (kind text, serial text, os_number text, unit text, technician text, happened_at timestamptz,
               current_status text, result text, result_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_any_role(array['admin', 'supervisor']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return query
    -- Entradas: os balões criados no período (transferências entre técnicos não são entrada).
    select case b.source when 'entrega' then 'entrega' when 'vidro' then 'vidro' else 'retorno' end,
           b.serial,
           (select so.os_number from public.service_orders so
             where so.id = coalesce((select st.os_id from public.repair_stages st where st.id = b.stage_id), a.os_id)),
           a.unit_id,
           public.lab_name(b.technician_id),
           b.created_at,
           (select x.status from public.lab_assets x where x.serial_key = b.serial_key order by x.entered_at desc limit 1),
           null::text,
           null::timestamptz
      from public.lab_balloons b
      join public.lab_assets a on a.id = b.asset_id
     where b.source in ('entrega', 'vidro', 'redistribuicao', 'retorno')
       and b.created_at >= p_from and b.created_at < p_to

    union all
    -- Saídas: PT, Bloqueado e Revenda pela data da finalização (checklist do balão ou da Análise técnica).
    select 'saida',
           e.serial,
           (select so.os_number from public.lab_assets x join public.service_orders so on so.id = x.os_id where x.id = e.asset_id),
           (select ast.asset_short_id from public.assets ast where ast.serial_key = e.serial_key limit 1),
           public.lab_name(e.from_id),
           e.created_at,
           (select x.status from public.lab_assets x where x.serial_key = e.serial_key order by x.entered_at desc limit 1),
           e.detail ->> 'destino',
           null::timestamptz
      from public.lab_events e
     where e.kind in ('finalizacao', 'analise_finalizada')
       and e.detail ->> 'destino' in ('pt', 'bloqueado', 'revenda')
       and e.created_at >= p_from and e.created_at < p_to
       and not (e.detail ->> 'destino' = 'pt'
                and exists (select 1 from public.lab_events r
                             where r.serial_key = e.serial_key and r.kind = 'pt_recusado' and r.created_at > e.created_at))

    union all
    -- Quarentena: envios desde 1 dia antes do período, com o primeiro resultado depois do envio.
    select 'quarentena',
           s.serial,
           s.os_number,
           (select ast.asset_short_id from public.assets ast where ast.serial_key = s.serial_key limit 1),
           public.lab_name(s.sender_id),
           s.sent_at,
           (select x.status from public.lab_assets x where x.serial_key = s.serial_key order by x.entered_at desc limit 1),
           q.result,
           q.created_at
      from public.repair_quarantine_sends() s
      left join lateral (
        select qc.result, qc.created_at from public.quarantine_checks qc
         where lower(btrim(qc.serial)) = s.serial_key and qc.created_at >= s.sent_at
         order by qc.created_at limit 1
      ) q on true
     where s.sent_at >= p_from - interval '1 day' and s.sent_at < p_to
       and not exists (
         select 1 from public.quarantine_dismissals d
          where d.serial_key = s.serial_key and d.dismissed_at >= s.sent_at
            and (q.created_at is null or d.dismissed_at < q.created_at))
    limit 10000;
end;
$$;

revoke all on function public.lab_flow(timestamptz, timestamptz) from public, anon;
grant execute on function public.lab_flow(timestamptz, timestamptz) to authenticated;
