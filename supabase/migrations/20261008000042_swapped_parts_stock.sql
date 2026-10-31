-- O estoquista também vê as peças trocadas (erro técnico e qualidade do fornecedor), para controlar as perdas.
-- Rode depois de 20261008000041_swapped_parts.sql. Pode rodar de novo.

create or replace function public.swapped_parts(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_user uuid default null
) returns table (
  reason text,
  part text,
  model text,
  technician text,
  user_id uuid,
  swapped_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.resolution, a.part, ast.model, coalesce(nullif(btrim(p.name), ''), p.email), r.requested_by, r.resolved_at
  from public.part_requests r
  join public.part_allocations a on a.id = r.allocation_id
  join public.profiles p on p.id = r.requested_by
  left join public.assets ast on ast.serial_key = a.serial_key
  where r.kind = 'troca'
    and r.status = 'atendida'
    and r.resolution in ('peca_ruim', 'erro_tecnico')
    and (select public.has_any_role(array['admin', 'supervisor', 'estoquista']::public.user_role[]))
    and (p_from is null or r.resolved_at >= p_from)
    and (p_to is null or r.resolved_at < p_to)
    and (p_user is null or r.requested_by = p_user)
  order by r.resolved_at desc
  limit 5000;
$$;

revoke all on function public.swapped_parts(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.swapped_parts(timestamptz, timestamptz, uuid) to authenticated;
