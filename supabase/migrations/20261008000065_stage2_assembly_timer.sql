-- Estágio 2: além do tempo de manutenção, o tempo de montagem (aparelho que só precisa ser montado, ex. depois do vidro).
-- Rode depois de 20261008000064_glass_timer_display.sql. Pode rodar de novo.
--
-- As sessões do cronômetro de uma etapa ganham a fase: 'manutencao' ou 'montagem' (vazia = como antes).
-- Continua existindo uma única sessão aberta por etapa: começar a montagem fecha a manutenção e vice-versa, então
-- nenhum tempo é contado duas vezes. A espera de peça é da etapa (aparece no cronômetro da manutenção).

alter table public.repair_timer_sessions drop constraint if exists repair_timer_phase_check;
alter table public.repair_timer_sessions
  add constraint repair_timer_phase_check check (phase is null or phase in ('analise', 'reparo_placa', 'manutencao', 'montagem'));

-- Troca a sessão aberta da etapa (null só encerra). Mesmo tipo e mesma fase: nada muda.
drop function if exists public.repair_timer_switch(uuid, text);

create or replace function public.repair_timer_switch(p_stage uuid, p_kind text, p_phase text default null) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_open public.repair_timer_sessions;
begin
  select * into v_open from public.repair_timer_sessions where stage_id = p_stage and ended_at is null for update;
  if found then
    if v_open.kind = p_kind and v_open.phase is not distinct from p_phase then
      return;
    end if;
    update public.repair_timer_sessions set ended_at = v_now where id = v_open.id;
  end if;
  if p_kind is not null then
    insert into public.repair_timer_sessions (stage_id, kind, started_at, phase) values (p_stage, p_kind, v_now, p_phase);
  end if;
end;
$$;

revoke all on function public.repair_timer_switch(uuid, text, text) from public, anon, authenticated;

-- Pedido de peça: o tempo produtivo (de manutenção ou de montagem) vira espera de peça.
create or replace function public.repair_timer_part_wait(p_stage uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.repair_timer_sessions where stage_id = p_stage and ended_at is null and kind = 'produtivo') then
    perform public.repair_timer_switch(p_stage, 'espera_peca');
  end if;
end;
$$;

revoke all on function public.repair_timer_part_wait(uuid) from public, anon, authenticated;

-- Iniciar / pausar / retomar. p_phase: 'manutencao' ou 'montagem' no Estágio 2; vazio nas outras etapas.
drop function if exists public.repair_timer_set(uuid, text);

create or replace function public.repair_timer_set(p_stage_id uuid, p_kind text, p_phase text default null) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage public.repair_stages;
begin
  if p_kind not in ('produtivo', 'pausa') then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  select * into v_stage from public.repair_stages where id = p_stage_id for update;
  if not found or not public.repair_can_act(v_stage) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  if v_stage.status <> 'em_andamento' then
    raise exception 'etapa já concluída' using errcode = 'P0001';
  end if;
  if p_phase is not null and (v_stage.stage <> 'manutencao' or p_phase not in ('manutencao', 'montagem')) then
    raise exception 'dados incompletos' using errcode = '22023';
  end if;
  perform public.repair_timer_switch(p_stage_id, p_kind, p_phase);
  perform public.repair_log(v_stage.os_id, p_stage_id, null, 'cronometro_' || coalesce(p_phase || '_', '') || p_kind);
end;
$$;

-- Totais. Sem fase: a etapa inteira (como antes). 'manutencao': produtivo e pausa da manutenção (sessões antigas, sem
-- fase, contam como manutenção) e toda a espera de peça. 'montagem': produtivo e pausa da montagem.
drop function if exists public.repair_timer_totals(uuid);

create or replace function public.repair_timer_totals(p_stage_id uuid, p_phase text default null) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'produtivo', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at))
                   filter (where s.kind = 'produtivo' and (p_phase is null or coalesce(s.phase, 'manutencao') = p_phase)), 0)::bigint,
    'pausa', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at))
                   filter (where s.kind = 'pausa' and (p_phase is null or coalesce(s.phase, 'manutencao') = p_phase)), 0)::bigint,
    'espera_peca', coalesce(sum(extract(epoch from coalesce(s.ended_at, now()) - s.started_at))
                   filter (where s.kind = 'espera_peca' and (p_phase is null or p_phase = 'manutencao')), 0)::bigint,
    'open_kind', (select o.kind from public.repair_timer_sessions o
                   where o.stage_id = p_stage_id and o.ended_at is null
                     and (p_phase is null
                          or (o.kind = 'espera_peca' and p_phase = 'manutencao')
                          or (o.kind <> 'espera_peca' and coalesce(o.phase, 'manutencao') = p_phase))),
    'server_now', now()
  )
  from (select 1) base
  left join public.repair_timer_sessions s on s.stage_id = p_stage_id
  where (select public.has_any_role(
    array['admin', 'supervisor', 'tecnico', 'desmontador', 'montador', 'estoquista', 'analista', 'tecnico_vidro']::public.user_role[]));
$$;

revoke all on function public.repair_timer_set(uuid, text, text) from public, anon;
revoke all on function public.repair_timer_totals(uuid, text) from public, anon;
grant execute on function public.repair_timer_set(uuid, text, text) to authenticated;
grant execute on function public.repair_timer_totals(uuid, text) to authenticated;
