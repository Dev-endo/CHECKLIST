-- Recomeçar o Dia Laboratório do zero: ninguém com balão, metas de balão e Acompanhamento zerados.
-- Rode no SQL Editor do Supabase depois das migrations 108 a 119 (é um script, não uma migration). Pode rodar de novo:
-- a cada vez, o que existir é somado à cópia de segurança e depois apagado.
--
-- Apaga só os dados do Dia Laboratório: lab_assets (passagens), lab_balloons (balões) e lab_events (histórico).
-- Checklists, quarentena, PT, vidro, OS, fila da análise e a aba Análise antiga ficam intactos.
--
-- Antes de apagar, guarda uma cópia em lab_*_backup_20261125 (sem acesso pela API). Para restaurar, veja o fim do
-- arquivo. Depois de conferir que está tudo certo, as cópias podem ser apagadas (drop table).

begin;

-- 1) Cópia de segurança (rodando de novo, soma o que existir agora à cópia).
create table if not exists public.lab_assets_backup_20261125 as select * from public.lab_assets with no data;
create table if not exists public.lab_balloons_backup_20261125 as select * from public.lab_balloons with no data;
create table if not exists public.lab_events_backup_20261125 as select * from public.lab_events with no data;
insert into public.lab_assets_backup_20261125 select * from public.lab_assets;
insert into public.lab_balloons_backup_20261125 select * from public.lab_balloons;
insert into public.lab_events_backup_20261125 select * from public.lab_events;

alter table public.lab_assets_backup_20261125 enable row level security;
alter table public.lab_balloons_backup_20261125 enable row level security;
alter table public.lab_events_backup_20261125 enable row level security;
revoke all on public.lab_assets_backup_20261125, public.lab_balloons_backup_20261125, public.lab_events_backup_20261125
  from anon, authenticated;

-- 2) Limpeza (histórico, balões e passagens).
truncate table public.lab_events, public.lab_balloons, public.lab_assets restart identity;

commit;

-- 3) Conferência: as três primeiras devem dar 0; as cópias, o que existia antes.
select 'lab_assets' as tabela, count(*) from public.lab_assets
union all select 'lab_balloons', count(*) from public.lab_balloons
union all select 'lab_events', count(*) from public.lab_events
union all select 'backup lab_assets', count(*) from public.lab_assets_backup_20261125
union all select 'backup lab_balloons', count(*) from public.lab_balloons_backup_20261125
union all select 'backup lab_events', count(*) from public.lab_events_backup_20261125;

-- Restaurar (só se precisar voltar atrás; rode estas linhas à parte, com as tabelas vazias):
--   insert into public.lab_assets (id, serial, unit_id, model, status, technician_id, last_technician_id, entered_by,
--     entered_at, exited_at, rejected_at, last_move_at, os_id)
--   select id, serial, unit_id, model, status, technician_id, last_technician_id, entered_by,
--     entered_at, exited_at, rejected_at, last_move_at, os_id from public.lab_assets_backup_20261125;
--   insert into public.lab_balloons (id, asset_id, serial, technician_id, status, source, from_id, note, stage_id, outcome,
--     transferred_to, created_at, confirmed_at, finished_at)
--   select id, asset_id, serial, technician_id, status, source, from_id, note, stage_id, outcome,
--     transferred_to, created_at, confirmed_at, finished_at from public.lab_balloons_backup_20261125;
--   insert into public.lab_events (id, asset_id, balloon_id, serial, kind, actor_id, from_id, to_id, detail, created_at, seq)
--   overriding system value
--   select id, asset_id, balloon_id, serial, kind, actor_id, from_id, to_id, detail, created_at, seq
--     from public.lab_events_backup_20261125;
