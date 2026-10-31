-- Novos papéis: analista (aba Análise técnica) e técnico de vidro (aba Vidro).
-- Rode ESTE arquivo sozinho, e só depois o 20261008000052: um valor novo de enum
-- não pode ser usado na mesma execução em que é criado.
alter type public.user_role add value if not exists 'analista';
alter type public.user_role add value if not exists 'tecnico_vidro';
