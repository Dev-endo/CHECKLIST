-- Aba Liberação (admin): todos os pedidos de liberação de checklist, pendentes e os decididos nos últimos dias.
-- Rode depois de 20261008000105_checklist_reassign.sql. Pode rodar de novo.
--
-- Os pendentes aparecem sempre (de qualquer data); os decididos aparecem por p_days dias. Só admin.

create or replace function public.list_checklist_requests_all(p_days integer default 7)
returns table (
  id uuid, serial text, os_number text, model text, requester text, owner text, status text,
  created_at timestamptz, decided_by text, decided_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.serial, o.os_number, a.model,
         (select coalesce(nullif(btrim(p.name), ''), p.email) from public.profiles p where p.id = r.requested_by),
         (select coalesce(nullif(btrim(p.name), ''), p.email) from public.profiles p where p.id = st.technician_id),
         r.status, r.created_at,
         (select coalesce(nullif(btrim(p.name), ''), p.email) from public.profiles p where p.id = r.decided_by),
         r.decided_at
    from public.checklist_release_requests r
    join public.repair_stages st on st.id = r.stage_id
    left join public.service_orders o on o.id = st.os_id
    left join public.assets a on a.serial_key = lower(btrim(r.serial))
   where (select public.has_any_role(array['admin']::public.user_role[]))
     and (r.status = 'pendente' or r.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 7), 1)))
   order by (r.status = 'pendente') desc, coalesce(r.decided_at, r.created_at) desc
   limit 500;
$$;

revoke all on function public.list_checklist_requests_all(integer) from public, anon;
grant execute on function public.list_checklist_requests_all(integer) to authenticated;
