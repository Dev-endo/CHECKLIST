-- Só e-mails @allugator.com criam conta (login Google ou qualquer outro caminho).
-- Vale para contas novas; quem já existe com outro domínio continua cadastrado.
create function public.enforce_email_domain() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if lower(coalesce(new.email, '')) not like '%@allugator.com' then
    raise exception 'Somente contas @allugator.com podem entrar.';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_email_domain() from public, anon, authenticated;

create trigger enforce_email_domain
before insert on auth.users
for each row execute function public.enforce_email_domain();
