-- Desmontagem técnica: consumo na fonte de bancada e marcação de PT, cada um com observação.
-- Rode depois de 20261008000020_extra_roles.sql. Pode rodar de novo.

alter table public.devices
  add column if not exists consumption boolean,
  add column if not exists consumption_note text check (char_length(consumption_note) <= 500),
  add column if not exists pt_flagged boolean,
  add column if not exists pt_note text check (char_length(pt_note) <= 500);
