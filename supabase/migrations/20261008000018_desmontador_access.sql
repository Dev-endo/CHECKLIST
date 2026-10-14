-- Acesso do desmontador. Rode depois de 20261008000017_role_desmontador.sql. Pode rodar de novo.
-- As duas desmontagens passam a ser só do desmontador (e do admin): o técnico fica só com a manutenção.

drop policy if exists "devices_insert_own" on public.devices;
create policy "devices_insert_own" on public.devices
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and phase = 'pendente'
    and (
      (kind = 'manutencao' and (select public.current_user_role()) in ('tecnico', 'admin'))
      or (kind in ('desmontagem', 'desmontagem_tecnica') and (select public.current_user_role()) in ('desmontador', 'admin'))
      or (kind = 'montagem' and (select public.current_user_role()) in ('montador', 'admin'))
    )
  );

drop policy if exists "devices_update_own_pending" on public.devices;
create policy "devices_update_own_pending" on public.devices
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and phase = 'pendente'
    and (
      (kind = 'manutencao' and (select public.current_user_role()) in ('tecnico', 'admin'))
      or (kind in ('desmontagem', 'desmontagem_tecnica') and (select public.current_user_role()) in ('desmontador', 'admin'))
      or (kind = 'montagem' and (select public.current_user_role()) in ('montador', 'admin'))
    )
  )
  with check (user_id = (select auth.uid()));

-- O desmontador também consulta a planilha de ativos ao bipar o serial.
drop policy if exists "assets_select" on public.assets;
create policy "assets_select" on public.assets
  for select to authenticated
  using ((select public.current_user_role()) in ('admin', 'supervisor', 'tecnico', 'montador', 'desmontador'));
