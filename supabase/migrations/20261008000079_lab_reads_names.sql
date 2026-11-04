-- Nome de quem pediu a peça (e de quem enviou, analisou, etc.) visível para quem trabalha no laboratório.
-- Rode depois de 20261008000078_pt_destination.sql. Pode rodar de novo.
--
-- Antes, só o admin e o supervisor liam os perfis de outras pessoas: o estoquista via "Técnico: —" no quadro do
-- estoque e o analista não via o nome de quem mandou o aparelho. Agora as funções do laboratório leem os perfis
-- (nome, e-mail e função). Quem está "Sem função" continua vendo só o próprio perfil. A edição não muda.

drop policy if exists "profiles_select_lab" on public.profiles;
create policy "profiles_select_lab" on public.profiles
  for select to authenticated
  using ((select public.has_any_role(array['admin', 'supervisor', 'tecnico', 'analista', 'tecnico_vidro', 'estoquista']::public.user_role[])));
