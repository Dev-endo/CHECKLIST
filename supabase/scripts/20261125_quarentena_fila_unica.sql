-- Fila única da quarentena (25/11): quem está na lista Aguardando da aba Quarentena (conferência física) e ainda aparece
-- em outra fila do laboratório (Aguardando manutenção, Vidro, Análise, Transferência pendente, Reprovado) passa a ficar
-- só em "Em quarentena". Rode no SQL Editor. Pode rodar de novo (na segunda vez não acha ninguém).
--
--   * O ativo vai para o status quarentena, sem técnico.
--   * O balão aberto ou pendente desse ativo sai da bancada do técnico (é apagado, não conta na meta).
--   * Fica um evento "ajuste_conferencia_quarentena" no histórico do serial, com o status e o técnico anteriores.
--   * Quando a quarentena registrar aprovado/reprovado, o fluxo normal segue (lab_on_quarantine).

-- 0) Prévia: quem vai ser ajustado (rode sozinho antes, se quiser conferir; deve dar 2 linhas).
select a.serial, a.status as status_atual, public.lab_name(a.technician_id) as tecnico,
       (select count(*) from public.lab_balloons b where b.asset_id = a.id and b.status in ('aberto', 'pendente')) as baloes_abertos
  from public.lab_assets a
 where a.exited_at is null
   and a.status <> 'quarentena'
   and a.serial_key in (select lower(btrim(r.serial)) from public.quarantine_pending_rows() r);

begin;

with alvo as (
  select a.* from public.lab_assets a
   where a.exited_at is null
     and a.status <> 'quarentena'
     and a.serial_key in (select lower(btrim(r.serial)) from public.quarantine_pending_rows() r)
   for update
),
baloes as (
  delete from public.lab_balloons b
   using alvo
   where b.asset_id = alvo.id and b.status in ('aberto', 'pendente')
  returning b.asset_id, b.id, b.technician_id
),
log as (
  insert into public.lab_events (asset_id, serial, kind, from_id, detail)
  select alvo.id, alvo.serial, 'ajuste_conferencia_quarentena', alvo.technician_id,
         jsonb_build_object(
           'status_anterior', alvo.status,
           'baloes_removidos', coalesce((select jsonb_agg(baloes.id) from baloes where baloes.asset_id = alvo.id), '[]'::jsonb))
    from alvo
)
update public.lab_assets a
   set status = 'quarentena', technician_id = null, last_move_at = now()
  from alvo
 where a.id = alvo.id;

commit;

-- Conferência: deve dar 0 (ninguém da lista Aguardando em outra fila).
select count(*) as ainda_em_duas_filas
  from public.lab_assets a
 where a.exited_at is null
   and a.status <> 'quarentena'
   and a.serial_key in (select lower(btrim(r.serial)) from public.quarantine_pending_rows() r);
