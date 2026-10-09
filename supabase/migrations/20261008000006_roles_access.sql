-- Acesso por papel. Rode depois de 20261008000005_roles_tecnico_montador.sql.
--   tecnico  : faz o checklist de manutenção
--   montador : faz o checklist de montagem
--   admin    : faz os dois, vê tudo e define os papéis
--   supervisor: só consulta
--   colaborador: "sem função": quem acabou de entrar espera o admin definir o papel

-- Quem já fazia checklist continua trabalhando.
update public.profiles set role = 'tecnico' where role = 'colaborador';

-- Só técnico e admin criam ou alteram checklists de manutenção (o dono, e só enquanto pendente).
drop policy "devices_insert_own" on public.devices;
create policy "devices_insert_own" on public.devices
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and phase = 'pendente'
    and (select public.current_user_role()) in ('tecnico', 'admin')
  );

drop policy "devices_update_own_pending" on public.devices;
create policy "devices_update_own_pending" on public.devices
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and phase = 'pendente'
    and (select public.current_user_role()) in ('tecnico', 'admin')
  )
  with check (user_id = (select auth.uid()));

-- A planilha de ativos não é lida por quem ainda está sem função.
drop policy "assets_select" on public.assets;
create policy "assets_select" on public.assets
  for select to authenticated
  using ((select public.current_user_role()) in ('admin', 'supervisor', 'tecnico', 'montador'));
