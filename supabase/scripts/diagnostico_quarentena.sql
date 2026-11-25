-- Onde está cada serial de uma lista (só leitura). Cole os seriais na lista abaixo e rode no SQL Editor.
-- "acompanhamento": se o serial conta em Dia Laboratório > Acompanhamento > Por destino > Quarentena de HOJE
-- (balão finalizado hoje com último destino quarentena) e, se não, por quê.
-- "aba_quarentena": se aparece na lista Aguardando da aba Quarentena.
with lista(serial) as (
  select btrim(s) from unnest(array[
    'SWP61J69HYW','SFW61VHLQ9Q','SG0G400WXH4','SQ52V9FQ93D','SQ13C2GQH61','SXGPDH4PMX5','SGQXJ0LHFGV','SV33RR4972D',
    'SH334N97DNJ','SFQPG72RX5T','SNT7CY5F452','SM24624XQF7','SF12X1PJWR0','SJQ13XFY16P','SPCQQV5XK9M','SYHX3L4V7RN',
    'SQ4FL7TVXYV','SG6L60CN492','WLQ6WF39PH','SNTXGTCDT21','SX247FHF127','SQHNY04LQJ3','SKD06R6VKFV','SGQKT429PWN',
    'SDK44D667VX','MGQWGKHYVP','SGF0JGW0KQQ','SPFL2F7G460','SJNP39P0QP3','SD4D66Q3060','PDYHKJ2MY6','JNVXY76HQR',
    'MM96YWN6Q4','SJV2RNXY52D','M4973PWQWP','VWYWQLFCXM','SHMXVWK7XND','SLR72YFDFV6','SHTMJWF75WM','SLHHQ7TL9DR',
    'SJ2TJP9VN2K','M04M0W6YG5','G0F9W56MX6','SQ39NFPNX5P','SKP6WHNYWTQ','SJW17TQK7DY','QM071L620G','STR92G571XP',
    'SKG72WXYYYP','SCF47PV2NGP','SH6KL2Q2PP2','XWWQQJRYHG','D2N3FQRL64','SFLX7ML9JRX','SCT2X977DK2','SRM909J3K59'
  ]) s
),
k as (select serial, lower(serial) as key from lista),
-- Mesma regra da lista "Aguardando" da aba Quarentena (quarantine_pending), sem a checagem de papel (o SQL Editor
-- não tem usuário logado): enviado para a quarentena, sem registro depois do envio e sem OS mais nova.
pend as (
  select distinct s.serial_key as key
    from public.repair_quarantine_sends() s
   where s.serial_key in (select key from k)
     and not exists (select 1 from public.quarantine_checks q
                      where lower(btrim(q.serial)) = s.serial_key and q.created_at >= s.sent_at)
     and not exists (select 1 from public.service_orders newer
                      where newer.serial_key = s.serial_key and newer.created_at > s.os_created)
),
ult as (
  -- Último checklist de manutenção do serial (qualquer tela).
  select distinct on (st.serial_key) st.serial_key, st.status, st.outcome, st.finished_at, st.legacy, st.technician_id, st.os_id
    from public.repair_stages st
   where st.stage = 'manutencao' and st.serial_key in (select key from k)
   order by st.serial_key, st.started_at desc
),
qc as (
  -- Último registro na aba Quarentena (aprovado/reprovado).
  select distinct on (lower(btrim(q.serial))) lower(btrim(q.serial)) as key, q.result, q.created_at
    from public.quarantine_checks q
   where lower(btrim(q.serial)) in (select key from k)
   order by lower(btrim(q.serial)), q.created_at desc
),
-- Último balão finalizado (ou transferido) hoje do serial: é o destino que o Acompanhamento conta.
bal as (
  select distinct on (b.serial_key) b.serial_key, b.status, b.outcome, b.finished_at
    from public.lab_balloons b
   where b.serial_key in (select key from k) and b.status in ('finalizado', 'transferido')
     and (b.finished_at at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date
   order by b.serial_key, b.finished_at desc
),
aberto as (
  select distinct on (b.serial_key) b.serial_key, b.status, public.lab_name(b.technician_id) as com
    from public.lab_balloons b
   where b.serial_key in (select key from k) and b.status in ('pendente', 'aberto')
   order by b.serial_key, b.created_at desc
),
lab as (
  select distinct on (a.serial_key) a.serial_key, a.status
    from public.lab_assets a where a.serial_key in (select key from k)
   order by a.serial_key, a.entered_at desc
)
select k.serial,
       case
         when bal.outcome = 'quarentena' and bal.status = 'finalizado' then 'OK: conta em Quarentena'
         when bal.status = 'transferido' then 'Último balão de hoje foi TRANSFERIDO (conta para quem recebeu ao finalizar)'
         when bal.outcome is not null then 'Último destino de hoje foi ' || bal.outcome || ' (conta lá, não em Quarentena)'
         when aberto.serial_key is not null then 'Balão ainda ' || aberto.status || ' com ' || coalesce(aberto.com, '?')
         when u.status = 'concluida' and (u.finished_at at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date
           then 'Checklist finalizado hoje para ' || u.outcome || ' SEM BALÃO (não conta no Acompanhamento)'
         when u.status <> 'concluida' then 'Checklist aberto, sem balão'
         when u.finished_at is not null and (u.finished_at at time zone 'America/Sao_Paulo')::date <> (now() at time zone 'America/Sao_Paulo')::date
           then 'Checklist finalizado em outro dia (' || to_char(u.finished_at at time zone 'America/Sao_Paulo', 'DD/MM') || ')'
         else 'Sem checklist finalizado hoje'
       end as acompanhamento,
       case
         when p.key is not null then 'OK: aguardando quarentena'
         when u.serial_key is null then 'SEM CHECKLIST de manutenção no sistema'
         when u.status <> 'concluida' then 'Checklist AINDA ABERTO (não finalizado)'
         when u.outcome <> 'quarentena' then 'Último checklist foi para: ' || u.outcome
         when qc.created_at >= u.finished_at then 'Já registrado na Quarentena: ' || qc.result
         when exists (select 1 from public.service_orders newer, public.service_orders o
                       where o.id = u.os_id and newer.serial_key = k.key and newer.created_at > o.created_at)
           then 'OS mais nova registrada depois do checklist'
         else 'Fora da lista por outro motivo'
       end as aba_quarentena,
       u.outcome as ultimo_destino,
       to_char(u.finished_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as finalizado_em,
       public.lab_name(u.technician_id) as tecnico,
       (select so.os_number from public.service_orders so where so.id = u.os_id) as os,
       qc.result as ultima_quarentena,
       to_char(qc.created_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as quarentena_em,
       lab.status as dia_laboratorio
  from k
  left join pend p on p.key = k.key
  left join ult u on u.serial_key = k.key
  left join qc on qc.key = k.key
  left join lab on lab.serial_key = k.key
  left join bal on bal.serial_key = k.key
  left join aberto on aberto.serial_key = k.key
 order by (bal.outcome = 'quarentena' and bal.status = 'finalizado') nulls first, k.serial;
