-- Saúde da bateria (%) informada no checklist, para comparar com a leitura depois do processo.
alter table public.devices
  add column battery_health smallint check (battery_health between 1 and 100);
