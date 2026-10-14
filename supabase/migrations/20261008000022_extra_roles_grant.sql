-- Permite ao admin gravar as funções extras. A tabela profiles só libera a coluna "role" para
-- atualização; sem este grant, a política RLS nem chega a ser avaliada e a gravação falha.
-- Rode depois de 20261008000020_extra_roles.sql. Pode rodar de novo.

grant update (extra_roles) on public.profiles to authenticated;
