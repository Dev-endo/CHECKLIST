-- Checklist manutenção: o admin troca o responsável e o técnico pede a liberação quando o checklist está com outro.
-- Rode depois de 20261008000104_reprovados_log.sql. Pode rodar de novo.
--
--   * admin_reassign_checklist: o admin passa o checklist em andamento para outro técnico. As marcações são mantidas
--     (quem recebe continua de onde parou).
--   * request_checklist_release: o técnico que bipou um checklist de outro pede a liberação ao admin.
--   * list_checklist_requests / decide_checklist_request: o admin vê os pedidos pendentes e aprova (o checklist vai para
--     quem pediu, com as marcações) ou recusa.

create table if not exists public.checklist_release_requests (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid not null references public.repair_stages (id) on delete cascade,
  serial text not null,
  requested_by uuid not null default auth.uid() references public.profiles (id),
  owner_id uuid references public.profiles (id),
  status text not null default 'pendente' check (status in ('pendente', 'aprovado', 'recusado', 'cancelado')),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- Um pedido pendente por checklist e por pessoa.
create unique index if not exists checklist_release_pending_idx
  on public.checklist_release_requests (stage_id, requested_by) where status = 'pendente';

alter table public.checklist_release_requests enable row level security;
revoke all on public.checklist_release_requests from anon, authenticated;

-- Admin: passa o checklist em andamento para outro técnico (mantém as marcações).
create or replace function public.admin_reassign_checklist(p_stage_id uuid, p_technician uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
begin
  if not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if p_technician is null or not exists (
       select 1 from public.profiles p
        where p.id = p_technician and (p.role = 'tecnico' or 'tecnico'::public.user_role = any (p.extra_roles))) then
    raise exception 'handover_target_invalid' using errcode = 'P0001';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id and stage = 'manutencao' for update;
  if not found or v_stage.status = 'concluida' then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;

  update public.repair_stages set technician_id = p_technician where id = v_stage.id;
  update public.checklist_release_requests
     set status = case when requested_by = p_technician then 'aprovado' else 'cancelado' end,
         decided_by = (select auth.uid()), decided_at = now()
   where stage_id = v_stage.id and status = 'pendente';
  perform public.repair_log(v_stage.os_id, v_stage.id, null, 'checklist_responsavel_trocado',
    jsonb_build_object('de', v_stage.technician_id, 'para', p_technician));
end;
$$;

revoke all on function public.admin_reassign_checklist(uuid, uuid) from public, anon;
grant execute on function public.admin_reassign_checklist(uuid, uuid) to authenticated;

-- Técnico: pede ao admin a liberação do checklist que está com outra pessoa. Devolve o id do pedido.
create or replace function public.request_checklist_release(p_serial text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_os public.service_orders;
  v_stage public.repair_stages;
  v_id uuid;
begin
  if not (select public.has_any_role(array['admin', 'tecnico']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  v_os := public.current_os(p_serial);
  select * into v_stage from public.repair_stages
   where os_id = v_os.id and stage = 'manutencao' and status = 'em_andamento'
   order by round desc limit 1;
  if not found then
    raise exception 'stage_closed' using errcode = 'P0001';
  end if;
  if v_stage.technician_id = (select auth.uid()) then
    raise exception 'handover_target_invalid' using errcode = 'P0001';
  end if;

  select id into v_id from public.checklist_release_requests
   where stage_id = v_stage.id and requested_by = (select auth.uid()) and status = 'pendente';
  if v_id is not null then
    return v_id;
  end if;
  insert into public.checklist_release_requests (stage_id, serial, requested_by, owner_id)
  values (v_stage.id, v_os.serial, (select auth.uid()), v_stage.technician_id)
  returning id into v_id;
  perform public.repair_log(v_os.id, v_stage.id, null, 'checklist_liberacao_pedida',
    jsonb_build_object('dono', v_stage.technician_id));
  return v_id;
end;
$$;

revoke all on function public.request_checklist_release(text) from public, anon;
grant execute on function public.request_checklist_release(text) to authenticated;

-- O pedido pendente da própria pessoa para o serial (para a tela mostrar "pedido enviado").
create or replace function public.my_checklist_release_pending(p_serial text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.checklist_release_requests r
     where r.requested_by = (select auth.uid()) and r.status = 'pendente'
       and lower(btrim(r.serial)) = lower(btrim(coalesce(p_serial, '')))
  );
$$;

revoke all on function public.my_checklist_release_pending(text) from public, anon;
grant execute on function public.my_checklist_release_pending(text) to authenticated;

-- Admin: os pedidos pendentes.
create or replace function public.list_checklist_requests()
returns table (id uuid, stage_id uuid, serial text, requester_id uuid, requester text, owner text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.stage_id, r.serial, r.requested_by,
         (select coalesce(nullif(btrim(p.name), ''), p.email) from public.profiles p where p.id = r.requested_by),
         (select coalesce(nullif(btrim(p.name), ''), p.email) from public.profiles p where p.id = st.technician_id),
         r.created_at
    from public.checklist_release_requests r
    join public.repair_stages st on st.id = r.stage_id
   where r.status = 'pendente'
     and st.status = 'em_andamento'
     and (select public.has_any_role(array['admin']::public.user_role[]))
   order by r.created_at;
$$;

revoke all on function public.list_checklist_requests() from public, anon;
grant execute on function public.list_checklist_requests() to authenticated;

-- Admin: aprova (o checklist vai para quem pediu) ou recusa.
create or replace function public.decide_checklist_request(p_id uuid, p_approve boolean) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.checklist_release_requests;
begin
  if not (select public.has_any_role(array['admin']::public.user_role[])) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into r from public.checklist_release_requests where id = p_id for update;
  if not found or r.status <> 'pendente' then
    raise exception 'pedido já fechado' using errcode = 'P0001';
  end if;
  if coalesce(p_approve, false) then
    perform public.admin_reassign_checklist(r.stage_id, r.requested_by);
  else
    update public.checklist_release_requests
       set status = 'recusado', decided_by = (select auth.uid()), decided_at = now()
     where id = r.id;
  end if;
end;
$$;

revoke all on function public.decide_checklist_request(uuid, boolean) from public, anon;
grant execute on function public.decide_checklist_request(uuid, boolean) to authenticated;
