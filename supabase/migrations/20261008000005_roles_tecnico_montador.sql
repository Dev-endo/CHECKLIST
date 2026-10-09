-- Novos papéis: técnico (checklist de manutenção) e montador (checklist de montagem).
-- Rode ESTE arquivo sozinho, e só depois o 20261008000006: um valor novo de enum
-- não pode ser usado na mesma execução em que é criado.
alter type public.user_role add value if not exists 'tecnico';
alter type public.user_role add value if not exists 'montador';
