-- Rodapé do técnico: quantos aparelhos ele mesmo finalizou no período (hoje e últimos 7 dias, na tela).
-- Rode depois de 20261008000074_legacy_checklist_simple.sql. Pode rodar de novo.
--
-- Conta aparelhos (por serial) cuja manutenção o próprio usuário finalizou (Estágio 2, Checklist manutenção ou
-- checklist e montagem do técnico de placa), por destino. Cada um só vê os próprios números.

create or replace function public.repair_my_summary(p_from date, p_to date) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select (p_from::timestamp at time zone 'America/Sao_Paulo') as t0,
           ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo') as t1
  ),
  mine as (
    select st.serial_key, st.outcome
    from public.repair_stages st, w
    where st.technician_id = (select auth.uid())
      and st.stage = 'manutencao' and st.status = 'concluida'
      and st.finished_at >= w.t0 and st.finished_at < w.t1
  )
  select jsonb_build_object(
    'ativos', (select count(distinct serial_key) from mine),
    'quarentena', (select count(distinct serial_key) from mine where outcome = 'quarentena'),
    'analise', (select count(distinct serial_key) from mine where outcome = 'analise'),
    'vidro', (select count(distinct serial_key) from mine where outcome = 'vidro'),
    'revenda', (select count(distinct serial_key) from mine where outcome = 'revenda')
  );
$$;

revoke all on function public.repair_my_summary(date, date) from public, anon;
grant execute on function public.repair_my_summary(date, date) to authenticated;
