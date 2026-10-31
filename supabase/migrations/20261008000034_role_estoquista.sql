-- Novo papel: estoquista (aba Estoque: aloca peças nos aparelhos e registra a OS).
-- Rode ESTE arquivo sozinho, e só depois o 20261008000035: um valor novo de enum
-- não pode ser usado na mesma execução em que é criado.
alter type public.user_role add value if not exists 'estoquista';
