-- Conferência física da quarentena (25/11): a lista Aguardando passa a ter exatamente os seriais abaixo.
-- Rode no SQL Editor DEPOIS da migration 20261008000123_quarantine_conference.sql. Pode rodar de novo.
--
--   * Quem está na lista Aguardando e não está abaixo sai da lista (sem gravar aprovado/reprovado). Se voltar a ser
--     enviado para a quarentena por um checklist, aparece de novo normalmente.
--   * Quem está abaixo e não estava na lista entra como "Incluído na conferência".

begin;

-- 1) Sai da lista quem não está na conferência.
with conferencia(serial) as (select btrim(s) from unnest(array[
  'SWP61J69HYW','SFW61VHLQ9Q','SG0G400WXH4','SQ52V9FQ93D','SQ13C2GQH61','SXGPDH4PMX5','SGQXJ0LHFGV','SV33RR4972D',
  'SH334N97DNJ','SFQPG72RX5T','SNT7CY5F452','SM24624XQF7','SF12X1PJWR0','SJQ13XFY16P','SPCQQV5XK9M','SYHX3L4V7RN',
  'SQ4FL7TVXYV','SG6L60CN492','WLQ6WF39PH','SNTXGTCDT21','SX247FHF127','SQHNY04LQJ3','SKD06R6VKFV','SGQKT429PWN',
  'SDK44D667VX','MGQWGKHYVP','SGF0JGW0KQQ','SPFL2F7G460','SJNP39P0QP3','SD4D66Q3060','PDYHKJ2MY6','JNVXY76HQR',
  'MM96YWN6Q4','SJV2RNXY52D','M4973PWQWP','VWYWQLFCXM','SHMXVWK7XND','SLR72YFDFV6','SHTMJWF75WM','SLHHQ7TL9DR',
  'SJ2TJP9VN2K','M04M0W6YG5','G0F9W56MX6','SQ39NFPNX5P','SKP6WHNYWTQ','SJW17TQK7DY','QM071L620G','STR92G571XP',
  'SKG72WXYYYP','SCF47PV2NGP','SH6KL2Q2PP2','XWWQQJRYHG','D2N3FQRL64','SFLX7ML9JRX','SCT2X977DK2','SRM909J3K59'
]) s)
insert into public.quarantine_dismissals (serial_key, dismissed_at)
select distinct lower(btrim(r.serial)), now()
  from public.quarantine_pending_rows() r
 where lower(btrim(r.serial)) not in (select lower(serial) from conferencia)
on conflict (serial_key) do update set dismissed_at = excluded.dismissed_at;

-- 2) Entra na lista quem está na conferência e não estava.
with conferencia(serial) as (select btrim(s) from unnest(array[
  'SWP61J69HYW','SFW61VHLQ9Q','SG0G400WXH4','SQ52V9FQ93D','SQ13C2GQH61','SXGPDH4PMX5','SGQXJ0LHFGV','SV33RR4972D',
  'SH334N97DNJ','SFQPG72RX5T','SNT7CY5F452','SM24624XQF7','SF12X1PJWR0','SJQ13XFY16P','SPCQQV5XK9M','SYHX3L4V7RN',
  'SQ4FL7TVXYV','SG6L60CN492','WLQ6WF39PH','SNTXGTCDT21','SX247FHF127','SQHNY04LQJ3','SKD06R6VKFV','SGQKT429PWN',
  'SDK44D667VX','MGQWGKHYVP','SGF0JGW0KQQ','SPFL2F7G460','SJNP39P0QP3','SD4D66Q3060','PDYHKJ2MY6','JNVXY76HQR',
  'MM96YWN6Q4','SJV2RNXY52D','M4973PWQWP','VWYWQLFCXM','SHMXVWK7XND','SLR72YFDFV6','SHTMJWF75WM','SLHHQ7TL9DR',
  'SJ2TJP9VN2K','M04M0W6YG5','G0F9W56MX6','SQ39NFPNX5P','SKP6WHNYWTQ','SJW17TQK7DY','QM071L620G','STR92G571XP',
  'SKG72WXYYYP','SCF47PV2NGP','SH6KL2Q2PP2','XWWQQJRYHG','D2N3FQRL64','SFLX7ML9JRX','SCT2X977DK2','SRM909J3K59'
]) s)
insert into public.quarantine_manual (serial)
select c.serial from conferencia c
 where lower(c.serial) not in (select lower(btrim(r.serial)) from public.quarantine_pending_rows() r);

commit;

-- 3) Conferência: deve dar 56 seriais, todos da lista.
select count(distinct lower(btrim(serial))) as seriais_aguardando,
       count(*) filter (where technician = 'Incluído na conferência') as incluidos_na_conferencia
  from public.quarantine_pending_rows();
