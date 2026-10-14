-- Novo papel: desmontador (desmontagem e desmontagem técnica).
-- Rode ESTE arquivo sozinho, e só depois o 20261008000018: um valor novo de enum
-- não pode ser usado na mesma execução em que é criado.
alter type public.user_role add value if not exists 'desmontador';
