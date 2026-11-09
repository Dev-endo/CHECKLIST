// Testa as migrations 44-93 (Reparo/Estoque) num Postgres em WASM, sem tocar no Supabase.
// Uso: npm i --no-save @electric-sql/pglite && node supabase/tests/repair_mvp.pglite.mjs
// As tabelas antigas (profiles, service_orders...) são recriadas de forma mínima aqui; dados só existem em memória.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const MIG = "supabase/migrations/";
const db = new PGlite();

// Esqueleto mínimo do que as migrations novas usam das antigas.
await db.exec(`
  create role authenticated; create role anon;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
  create type public.user_role as enum ('admin','supervisor','tecnico','desmontador','montador','estoquista','colaborador');
  create table public.assets (id int, serial_key text, asset_short_id text, model text);
  create table public.quarantine_checks (id uuid primary key default gen_random_uuid(), serial text not null, result text not null, user_id uuid, created_at timestamptz not null default now());
  alter table public.quarantine_checks enable row level security;
  grant select, insert on public.quarantine_checks to authenticated;
  create table public.profiles (id uuid primary key, name text, email text, role public.user_role not null default 'colaborador', extra_roles public.user_role[] not null default '{}');
  create function public.has_any_role(p_roles public.user_role[]) returns boolean language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and (p.role = any (p_roles) or p.extra_roles && p_roles)); $$;
  create table public.service_orders (
    id uuid primary key default gen_random_uuid(), serial text not null,
    serial_key text generated always as (lower(btrim(serial))) stored, os_number text not null,
    user_id uuid, created_at timestamptz not null default now());
  create function public.current_os(p_serial text) returns public.service_orders language plpgsql security definer set search_path = '' as $$
    declare v_os public.service_orders; begin
      select * into v_os from public.service_orders where serial_key = lower(btrim(coalesce(p_serial, ''))) order by created_at desc limit 1;
      if not found then raise exception 'no_os' using errcode = 'P0001'; end if; return v_os; end; $$;
  create table public.part_requests (id uuid primary key default gen_random_uuid(), os_id uuid, serial text, part text, kind text, status text, requested_by uuid, created_at timestamptz default now());
`);

const U = {
  tec: "00000000-0000-0000-0000-000000000001",
  tec2: "00000000-0000-0000-0000-000000000002",
  est: "00000000-0000-0000-0000-000000000003",
  sup: "00000000-0000-0000-0000-000000000004",
};
await db.exec(`
  insert into public.profiles (id, name, email, role) values
   ('${U.tec}','Tec','t@x','tecnico'),('${U.tec2}','Tec2','t2@x','tecnico'),
   ('${U.est}','Est','e@x','estoquista'),('${U.sup}','Sup','s@x','supervisor');
`);

async function applyAll() {
  for (const f of ["44_repair_stages_timer", "45_stock_requests_v2", "46_stock_request_functions", "47_repair_flow_functions", "48_stock_requests_compat_view", "49_technical_evaluation_stage", "50_maintenance_failed_tests", "51_roles_analista_vidro", "52_stage1_destinations_glass", "53_quarantine_pending", "54_quarantine_everyone", "55_requarantine_new_round", "56_technical_analysis", "57_analysis_timer", "58_board_repair", "59_analysis_sent_by", "60_return_to_sender", "61_analysis_test_parts", "62_board_test_parts", "63_maintenance_to_glass", "64_glass_timer_display", "65_stage2_assembly_timer", "66_board_to_assembly_checklist", "67_analyst_does_swap", "68_maintenance_count", "69_timer_finish", "70_dashboard", "71_dashboard_sent_to_glass", "72_dashboard_sent_to_analysis", "73_legacy_maintenance_checklist", "74_legacy_checklist_simple", "75_my_production", "76_replacement_reason", "77_analysis_send_note", "78_pt_destination", "79_lab_reads_names", "80_part_wait_ends_on_delivery", "81_test_part_kept_notice", "82_glass_flag_goal", "83_maintenance_visibility", "84_individual_productivity", "85_blocked_destination", "86_dashboard_blocked_maintenance_list", "87_resale_out_of_analysis", "88_legacy_checklist_takeover", "89_return_reason", "90_glass_direct_flow", "91_glass_keep_checklist", "92_cleaning_maintenance", "93_daily_goal_10"]) {
    const n = f.split("_")[0];
    const name = `202610080000${n}_${f.slice(3)}.sql`;
    await db.exec(readFileSync(MIG + name, "utf8"));
  }
}
await applyAll();
await applyAll(); // idempotente
console.log("migrations 44-93 aplicadas (2x)");

const V = {
  vid: "00000000-0000-0000-0000-000000000005",
  ana: "00000000-0000-0000-0000-000000000006",
};
Object.assign(U, V);
await db.exec(`insert into public.profiles (id, name, email, role) values ('${V.vid}','Vid','v@x','tecnico_vidro'),('${V.ana}','Ana','a@x','analista')`);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + extra}`); };

async function as(user, sql, params = []) {
  await db.exec(`set app.uid = '${U[user]}'; set role authenticated;`);
  try {
    const r = await db.query(sql, params);
    return { rows: r.rows };
  } catch (e) {
    return { err: e.message, code: e.code };
  } finally {
    await db.exec(`reset role;`);
  }
}
const one = async (user, sql, params) => { const r = await as(user, sql, params); return r.err ? r : r.rows[0] && Object.values(r.rows[0])[0]; };

await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER1','OS-1','${U.tec}')`);

// ---- Permissões e Estágio 1
let r = await as("est", `select public.start_disassembly('SER1')`);
ok("estoquista não inicia desmontagem", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("sup", `select public.start_disassembly('SER1')`);
ok("supervisor não inicia desmontagem", r.err?.includes("sem permissão"));
r = await as("tec", `select public.start_disassembly('SEM-OS')`);
ok("sem OS é recusado", r.err === "no_os", JSON.stringify(r));
const s1 = await one("tec", `select public.start_disassembly('SER1')`);
ok("técnico inicia a desmontagem", typeof s1 === "string", JSON.stringify(s1));
ok("iniciar de novo devolve a mesma etapa", (await one("tec", `select public.start_disassembly('ser1 ')`)) === s1);

// ---- Cronômetro
r = await as("tec2", `select public.repair_timer_set('${s1}','produtivo')`);
ok("outro técnico não mexe no cronômetro", r.err?.includes("sem permissão"));
r = await as("tec", `select public.repair_timer_set('${s1}','espera_peca')`);
ok("espera_peca não é manual", r.err?.includes("dados incompletos"));
await as("tec", `select public.repair_timer_set('${s1}','produtivo')`);
let tot = await one("tec", `select public.repair_timer_totals('${s1}')`);
ok("cronômetro produtivo aberto", tot.open_kind === "produtivo", JSON.stringify(tot));
r = await db.query(`select count(*)::int c from public.repair_timer_sessions where stage_id='${s1}' and ended_at is null`);
ok("só uma sessão aberta", r.rows[0].c === 1);
r = await db.exec(`insert into public.repair_timer_sessions (stage_id, kind) values ('${s1}','pausa')`).catch(e => e);
ok("banco impede 2ª sessão aberta", r instanceof Error && /unique|duplicate/i.test(r.message), String(r));

// ---- Solicitações
const req = async (user, part, purpose, qty = 1) => as(user, `select public.create_stock_request('SER1', $1, $2, $3)`, [part, purpose, qty]);
r = await req("est", "Bateria", "teste");
ok("estoquista não solicita", r.err?.includes("sem permissão"));
r = await req("tec", "Bateria", "teste");
const tBat = r.rows[0] && Object.values(r.rows[0])[0];
ok("técnico solicita teste (bateria)", !!tBat, JSON.stringify(r));
tot = await one("tec", `select public.repair_timer_totals('${s1}')`);
ok("pedir peça pausa o produtivo (espera_peca)", tot.open_kind === "espera_peca", JSON.stringify(tot));
r = await req("tec", "bateria ", "teste");
ok("2ª bateria de teste bloqueada (23505)", r.code === "23505", JSON.stringify(r));
r = await req("tec", "Display", "teste");
ok("outro tipo de teste liberado", !r.err, JSON.stringify(r));
const tDisp = Object.values(r.rows[0])[0];
r = await req("tec", "Prox", "teste", 3);
ok("teste com qty 3 recusado", !!r.err);
r = await as("tec", `select public.repair_timer_set('${s1}','produtivo')`);
tot = await one("tec", `select public.repair_timer_totals('${s1}')`);
ok("técnico retoma com peça pendente", tot.open_kind === "produtivo");
r = await req("tec", "Tela", "definitiva", 3);
const dTela = Object.values(r.rows[0])[0];
ok("definitiva com qty 3", !!dTela, JSON.stringify(r));

// ---- Entrega (só estoque), parcial, lote, idempotência
r = await as("tec", `select public.deliver_stock_requests($1::jsonb, 'k1')`, [JSON.stringify([{ id: tBat, qty: 1 }])]);
ok("técnico não confirma entrega", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("est", `select public.set_stock_request_status('${dTela}','em_separacao')`);
ok("estoquista marca em separação", !r.err, JSON.stringify(r));
r = await as("est", `select public.deliver_stock_requests($1::jsonb, 'k2')`, [JSON.stringify([{ id: dTela, qty: 2 }])]);
let q = (await db.query(`select status, qty_delivered from public.stock_requests where id='${dTela}'`)).rows[0];
ok("entrega parcial 2/3 mantém saldo", q.qty_delivered === 2 && q.status === "em_separacao", JSON.stringify(q));
r = await as("est", `select public.deliver_stock_requests($1::jsonb, 'k2')`, [JSON.stringify([{ id: dTela, qty: 2 }])]);
q = (await db.query(`select qty_delivered from public.stock_requests where id='${dTela}'`)).rows[0];
ok("reenviar o mesmo lote não duplica", q.qty_delivered === 2, JSON.stringify(q));
r = await as("est", `select public.deliver_stock_requests($1::jsonb, 'k3')`, [JSON.stringify([{ id: dTela, qty: 2 }])]);
ok("entrega acima do saldo recusada", r.err?.includes("entrega acima"), JSON.stringify(r));
r = await as("est", `select public.deliver_stock_requests($1::jsonb, 'k4')`, [JSON.stringify([{ id: dTela, qty: 1 }, { id: tBat }, { id: tDisp }])]);
const mv = (await db.query(`select count(*)::int c from public.stock_movements where kind='entrega' and idempotency_key like 'k4:%'`)).rows[0].c;
ok("lote grava 1 movimentação por solicitação", mv === 3, String(mv));
q = (await db.query(`select status from public.stock_requests where id in ('${dTela}','${tBat}','${tDisp}')`)).rows;
ok("todas entregues", q.every(x => x.status === "entregue"), JSON.stringify(q));

// ---- Cancelamento
r = await req("tec", "Flash", "definitiva", 1);
const dFlash = Object.values(r.rows[0])[0];
r = await as("tec2", `select public.cancel_stock_request('${dFlash}','sem motivo')`);
ok("técnico não cancela pedido de outro", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("tec", `select public.cancel_stock_request('${dFlash}','')`);
ok("cancelar exige justificativa", r.err?.includes("dados incompletos"));
r = await as("tec", `select public.cancel_stock_request('${dTela}','mudei de ideia')`);
ok("não cancela o que já foi entregue", r.err?.includes("pedido já fechado"));
r = await as("tec", `select public.cancel_stock_request('${dFlash}','pedido errado')`);
ok("técnico cancela o próprio pedido", !r.err, JSON.stringify(r));

// ---- Destino do teste
r = await as("tec", `select public.define_test_destiny('${tBat}','utilizacao_definitiva')`);
ok("destino: utilização definitiva", !r.err, JSON.stringify(r));
r = await as("tec", `select public.define_test_destiny('${tBat}', 'devolucao', 'Peça não serviu')`);
ok("destino só pode ser definido uma vez", r.err?.includes("destino já definido"));
const baixaTotal = (await db.query(`select coalesce(sum(stock_effect),0)::int s from public.stock_movements where request_id='${tBat}'`)).rows[0].s;
ok("utilização definitiva não gera 2ª baixa", baixaTotal === -1, String(baixaTotal));
r = await req("tec", "Bateria", "teste");
ok("novo teste do mesmo tipo liberado após destino", !r.err, JSON.stringify(r));
const tBat2 = Object.values(r.rows[0])[0];
await as("est", `select public.deliver_stock_requests($1::jsonb, 'k5')`, [JSON.stringify([{ id: tBat2 }])]);
r = await req("tec", "Bateria", "teste");
ok("sem destino, teste entregue ainda bloqueia o tipo", r.code === "23505", JSON.stringify(r));
r = await as("tec", `select public.define_test_destiny('${tBat2}', 'devolucao', 'Peça não serviu')`);
const ret1 = r.rows?.[0] && Object.values(r.rows[0])[0];
ok("destino: devolução cria devolução", !!ret1, JSON.stringify(r));

// ---- Devolução exige motivo
r = await req("tec", "Bateria", "teste");
const tBat3 = Object.values(r.rows[0])[0];
await as("est", `select public.deliver_stock_requests($1::jsonb, 'k5b')`, [JSON.stringify([{ id: tBat3 }])]);
r = await as("tec", `select public.define_test_destiny('${tBat3}', 'devolucao')`);
ok("devolução sem motivo recusada", r.err?.includes("return_reason_required"), JSON.stringify(r));
r = await as("tec", `select public.define_test_destiny('${tBat3}', 'devolucao', '  abc ')`);
ok("motivo curto recusado", r.err?.includes("return_reason_required"), JSON.stringify(r));
ok("recusada não define o destino", (await db.query(`select test_destiny from public.stock_requests where id='${tBat3}'`)).rows[0].test_destiny === null);
r = await as("tec", `select public.define_test_destiny('${tBat3}', 'devolucao', '  Veio com defeito de fábrica  ')`);
const ret3 = r.rows?.[0] && Object.values(r.rows[0])[0];
ok("devolução com motivo criada", !!ret3, JSON.stringify(r));
ok("motivo gravado na devolução, sem espaços", (await db.query(`select request_note from public.stock_returns where id='${ret3}'`)).rows[0].request_note === "Veio com defeito de fábrica");
await as("est", `select public.confirm_stock_return('${ret3}','funcional')`);
r = await req("tec", "Bateria", "teste");
const tBat4 = Object.values(r.rows[0])[0];
await as("est", `select public.deliver_stock_requests($1::jsonb, 'k5c')`, [JSON.stringify([{ id: tBat4 }])]);
r = await as("tec", `select public.define_test_destiny('${tBat4}', 'utilizacao_definitiva')`);
ok("utilização definitiva continua sem motivo", !r.err, JSON.stringify(r));

// ---- Recebimento (só estoque)
r = await as("tec", `select public.confirm_stock_return('${ret1}','funcional')`);
ok("técnico não confirma recebimento", r.err?.includes("sem permissão"));
r = await as("est", `select public.confirm_stock_return('${ret1}','nao-sei')`);
ok("condição inválida recusada", r.err?.includes("dados incompletos"));
r = await as("est", `select public.confirm_stock_return('${ret1}','funcional','rk1')`);
ok("estoque recebe devolução funcional", !r.err, JSON.stringify(r));
r = await as("est", `select public.confirm_stock_return('${ret1}','funcional','rk1')`);
ok("recebimento duplicado recusado", r.err?.includes("já recebida"));
let eff = (await db.query(`select coalesce(sum(stock_effect),0)::int s from public.stock_movements where request_id='${tBat2}'`)).rows[0].s;
ok("funcional volta ao disponível (-1 +1 = 0)", eff === 0, String(eff));

// ---- Substituição de definitiva
r = await as("tec", `select public.request_replacement('${dTela}', 1, null, 'Tela sem touch')`);
ok("substituição sem tipo de falha recusada", r.err?.includes("replace_failure_required"), JSON.stringify(r));
r = await as("tec", `select public.request_replacement('${dTela}', 1, 'falha_teste', ' ')`);
ok("substituição sem motivo recusada", r.err?.includes("replace_reason_required"), JSON.stringify(r));
r = await as("tec", `select public.request_replacement('${dTela}', 5, 'falha_teste', 'Tela sem touch')`);
ok("substituição acima do entregue recusada", r.err?.includes("acima do entregue"), JSON.stringify(r));
r = await as("tec", `select public.request_replacement('${dTela}', 1, 'falha_teste', 'Tela sem touch')`);
const repl = r.rows?.[0] && Object.values(r.rows[0])[0];
ok("substituição cria solicitação vinculada", !!repl, JSON.stringify(r));
q = (await db.query(`select replaces_request_id, status, replace_failure, replace_reason from public.stock_requests where id='${repl}'`)).rows[0];
ok("vinculada à original", q.replaces_request_id === dTela && q.status === "pendente", JSON.stringify(q));
ok("substituição grava tipo de falha e motivo", q.replace_failure === "falha_teste" && q.replace_reason === "Tela sem touch", JSON.stringify(q));
const ret2 = (await db.query(`select id from public.stock_returns where request_id='${dTela}'`)).rows[0].id;

// ---- Finalizar Estágio 1 com pendências e abrir Estágio 2
const sEval = await one("tec", `select public.finish_disassembly('${s1}')`);
ok("concluir desmontagem com pedido pendente abre a avaliação técnica", typeof sEval === "string", JSON.stringify(sEval));
q = (await db.query(`select stage, status from public.repair_stages where id='${sEval}'`)).rows[0];
ok("avaliação técnica em andamento", q.stage === "avaliacao" && q.status === "em_andamento", JSON.stringify(q));
tot = await one("tec", `select public.repair_timer_totals('${sEval}')`);
ok("cronômetro da avaliação começa sozinho", tot.open_kind === "produtivo", JSON.stringify(tot));
tot = await one("tec", `select public.repair_timer_totals('${s1}')`);
ok("cronômetro da desmontagem foi encerrado", tot.open_kind === null);
q = (await db.query(`select stage_id from public.stock_requests where id='${repl}'`)).rows[0];
ok("solicitação pendente acompanha a avaliação", q.stage_id === sEval);
r = await req("tec", "Vibracall", "definitiva", 1);
const dVib = Object.values(r.rows[0])[0];
tot = await one("tec", `select public.repair_timer_totals('${sEval}')`);
ok("pedir peça na avaliação pausa só o cronômetro dela (espera_peca)", tot.open_kind === "espera_peca", JSON.stringify(tot));
q = (await db.query(`select origin_stage from public.stock_requests where id='${dVib}'`)).rows[0];
ok("pedido registra a avaliação como etapa de origem", q.origin_stage === "avaliacao", JSON.stringify(q));
await as("tec", `select public.cancel_stock_request('${dVib}','teste de avaliação')`);
r = await as("tec", `select public.finish_disassembly('${s1}')`);
ok("desmontagem não conclui duas vezes", r.err === "stage_closed", JSON.stringify(r));
r = await as("tec2", `select public.finish_evaluation('${sEval}')`);
ok("outro técnico não conclui a avaliação", r.err?.includes("sem permissão"));
r = await as("est", `select public.finish_evaluation('${sEval}')`);
ok("estoquista não conclui a avaliação", r.err?.includes("sem permissão"));
const s2 = await one("tec", `select public.finish_evaluation('${sEval}')`);
ok("concluir avaliação abre o Estágio 2", typeof s2 === "string", JSON.stringify(s2));
q = (await db.query(`select stage, status from public.repair_stages where id='${s2}'`)).rows[0];
ok("Estágio 2 em andamento", q.stage === "manutencao" && q.status === "em_andamento");
q = (await db.query(`select stage_id from public.stock_requests where id='${repl}'`)).rows[0];
ok("solicitação pendente acompanha o Estágio 2", q.stage_id === s2);

// ---- Regras de finalização
const fin = (extra = "") => as("tec", `select public.finish_maintenance('${s2}', array['t1','t2'], array['t3'], ${extra || "false, null"}, p_analysis_note => 'Motivo de teste')`);
await as("tec", `select public.save_repair_checklist('${s2}','aberto','{"t1":"ok","t2":"ok"}')`);
r = await fin();
ok("bloqueia com teste obrigatório sem resposta", r.err === "tests_pending", JSON.stringify(r));
await as("tec", `select public.save_repair_checklist('${s2}','fechado','{"t3":"ok"}')`);
r = await fin();
ok("bloqueia com solicitação pendente", r.err === "request_pending", JSON.stringify(r));
await as("est", `select public.deliver_stock_requests($1::jsonb, 'k6')`, [JSON.stringify([{ id: repl }])]);
r = await fin();
ok("bloqueia com teste de display entregue sem destino", r.err === "test_destiny_missing", JSON.stringify(r));
await as("tec", `select public.define_test_destiny('${tDisp}','utilizacao_definitiva')`);
r = await fin();
ok("bloqueia com recebimento de defeituosa não confirmado", r.err === "return_unconfirmed", JSON.stringify(r));
await as("est", `select public.confirm_stock_return('${ret2}','com_defeito')`);
q = (await db.query(`select count(*)::int c from public.stock_segregated where return_id='${ret2}'`)).rows[0].c;
ok("peça com defeito fica segregada", q === 1);
eff = (await db.query(`select count(*)::int c from public.stock_movements where return_id='${ret2}' and kind='retorno_disponivel'`)).rows[0].c;
ok("defeituosa não volta ao disponível", eff === 0);
// teste pendente de destino
r = await req("tec", "Camera", "teste");
const tCam = Object.values(r.rows[0])[0];
r = await fin();
ok("bloqueia com pedido novo aberto", r.err === "request_pending");
await as("est", `select public.deliver_stock_requests($1::jsonb, 'k7')`, [JSON.stringify([{ id: tCam }])]);
r = await fin();
ok("bloqueia com teste entregue sem destino", r.err === "test_destiny_missing", JSON.stringify(r));
await as("tec", `select public.define_test_destiny('${tCam}','utilizacao_definitiva')`);
r = await fin("true, 'x'");
ok("revenda exige justificativa", r.err === "resale_reason_required", JSON.stringify(r));
r = await as("tec2", `select public.finish_maintenance('${s2}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`);
ok("outro técnico não finaliza", r.err?.includes("sem permissão"));
r = await fin();
ok("tudo aprovado -> quarentena", r.rows?.[0] && Object.values(r.rows[0])[0] === "quarentena", JSON.stringify(r));
r = await fin();
ok("não finaliza duas vezes", r.err === "stage_closed");
tot = await one("tec", `select public.repair_timer_totals('${s2}')`);
ok("cronômetro encerrado ao finalizar", tot.open_kind === null);

// ---- Reprovado vai para a fila de Análise
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER2','OS-2','${U.tec}')`);
const a1 = await one("tec", `select public.start_disassembly('SER2')`);
const aEval = await one("tec", `select public.finish_disassembly('${a1}')`);
r = await as("tec", `select public.finish_maintenance('${aEval}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`);
ok("manutenção não finaliza em etapa de avaliação", !!r.err);
const a2 = await one("tec", `select public.finish_evaluation('${aEval}')`);
await as("tec", `select public.save_repair_checklist('${a2}','aberto','{"t1":"fail","t2":"ok"}')`);
await as("tec", `select public.save_repair_checklist('${a2}','fechado','{"t3":"ok"}')`);
r = await as("tec", `select public.finish_maintenance('${a2}', array['t1','t2'], array['t3'])`);
ok("reprovado sem justificativa da análise recusado", r.err === "analysis_note_required", JSON.stringify(r));
r = await as("tec", `select public.finish_maintenance('${a2}', array['t1','t2'], array['t3'], p_analysis_note => 'Motivo de teste')`);
ok("justificativa da manutenção gravada na fila", (await db.query(`select send_note from public.repair_analysis_queue where serial='SER2'`)).rows[0]?.send_note === "Motivo de teste");
ok("teste reprovado -> analise", r.rows?.[0] && Object.values(r.rows[0])[0] === "analise", JSON.stringify(r));
q = (await db.query(`select failed_tests from public.repair_analysis_queue where serial='SER2'`)).rows[0];
ok("reprovados registrados na fila de Análise", q && q.failed_tests[0].teste === "t1", JSON.stringify(q));

// ---- Tópico de escolha (original/paralelo) não reprova; item apontado só vale com tópico reprovado
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER4','OS-4','${U.tec}')`);
const c1 = await one("tec", `select public.start_disassembly('SER4')`);
const c2 = await one("tec", `select public.finish_evaluation('${await one("tec", `select public.finish_disassembly('${c1}')`)}')`);
await as("tec", `select public.save_repair_checklist('${c2}','aberto','{"t1":"ok","opt":"fail","item-x":"fail"}')`);
await as("tec", `select public.save_repair_checklist('${c2}','fechado','{"t3":"ok"}')`);
r = await as("tec", `select public.finish_maintenance('${c2}', array['t1','opt'], array['t3'], false, null, array['opt'], p_analysis_note => 'Motivo de teste')`);
ok("tópico de escolha em 'fail' não reprova (quarentena)", r.rows?.[0] && Object.values(r.rows[0])[0] === "quarentena", JSON.stringify(r));
q = (await db.query(`select failed_tests from public.repair_stages where id='${c2}'`)).rows[0];
ok("sem reprovado não registra itens soltos", q.failed_tests.length === 0, JSON.stringify(q));

await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER5','OS-5','${U.tec}')`);
const d1 = await one("tec", `select public.start_disassembly('SER5')`);
const d2 = await one("tec", `select public.finish_evaluation('${await one("tec", `select public.finish_disassembly('${d1}')`)}')`);
await as("tec", `select public.save_repair_checklist('${d2}','fechado','{"t3":"fail","foco":"fail","confirm:imei":"ok"}')`);
r = await as("tec", `select public.finish_maintenance('${d2}', array[]::text[], array['t3'], false, null, array[]::text[], p_analysis_note => 'Motivo de teste')`);
ok("reprovado com item apontado vai para análise", r.rows?.[0] && Object.values(r.rows[0])[0] === "analise", JSON.stringify(r));
q = (await db.query(`select failed_tests from public.repair_stages where id='${d2}'`)).rows[0];
ok("registra o teste e o item apontado (sem as confirmações)", JSON.stringify(q.failed_tests) === JSON.stringify([{ fase: "fechado", teste: "t3" }, { fase: "fechado", item: "foco" }]), JSON.stringify(q));

// ---- Fim do Estágio 1: aguardando peças, vidro e análise técnica
const evalOf = async (serial, os) => {
  await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('${serial}','${os}','${U.tec}')`);
  const st = await one("tec", `select public.start_disassembly('${serial}')`);
  return one("tec", `select public.finish_disassembly('${st}')`);
};
const reqOn = (serial, part, purpose = "definitiva", qty = 1) => as("tec", `select public.create_stock_request('${serial}', $1, $2, $3)`, [part, purpose, qty]);

r = await as("tec", `select public.finish_evaluation('${await evalOf("SER6", "OS-6")}', 'qualquer')`);
ok("destino inválido recusado", r.err?.includes("dados incompletos"));

const e7 = await evalOf("SER7", "OS-7");
r = await as("tec", `select public.finish_evaluation('${e7}', 'aguardando_pecas')`);
ok("aguardando peças sem pedido aberto é recusado", r.err === "nothing_to_wait", JSON.stringify(r));

// aguardando peças: abre sozinho quando o estoque resolve tudo
const e8 = await evalOf("SER8", "OS-8");
const wt1 = Object.values((await reqOn("SER8", "Bateria")).rows[0])[0];
const w2 = Object.values((await reqOn("SER8", "Display")).rows[0])[0];
const m8 = await one("tec", `select public.finish_evaluation('${e8}', 'aguardando_pecas')`);
q = (await db.query(`select status, stage from public.repair_stages where id='${m8}'`)).rows[0];
ok("aguardando peças: Estágio 2 fica aguardando_pecas", q.status === "aguardando_pecas" && q.stage === "manutencao", JSON.stringify(q));
q = (await db.query(`select destination, status from public.repair_stages where id='${e8}'`)).rows[0];
ok("avaliação encerrada com destino aguardando_pecas", q.destination === "aguardando_pecas" && q.status === "concluida");
q = (await db.query(`select stage_id from public.stock_requests where id='${wt1}'`)).rows[0];
ok("pedidos abertos acompanham o Estágio 2", q.stage_id === m8);
r = await as("tec", `select public.save_repair_checklist('${m8}','aberto','{}')`);
ok("enquanto aguarda, o Estágio 2 não aceita marcações", r.err === "stage_closed", JSON.stringify(r));
await as("est", `select public.deliver_stock_requests($1::jsonb, 'wt1')`, [JSON.stringify([{ id: wt1 }])]);
q = (await db.query(`select status from public.repair_stages where id='${m8}'`)).rows[0];
ok("com um pedido ainda aberto, continua aguardando", q.status === "aguardando_pecas");
await as("tec", `select public.cancel_stock_request('${w2}','não precisa mais')`);
q = (await db.query(`select status from public.repair_stages where id='${m8}'`)).rows[0];
ok("resolvidos todos os pedidos, o Estágio 2 abre sozinho", q.status === "em_andamento", JSON.stringify(q));

// análise técnica
const e9 = await evalOf("SER9", "OS-9");
r = await as("tec", `select public.finish_evaluation('${e9}', 'analise')`);
ok("Estágio 1 para a análise sem justificativa recusado", r.err === "analysis_note_required", JSON.stringify(r));
r = await as("tec", `select public.finish_evaluation('${e9}', 'analise', '  ok ')`);
ok("justificativa curta recusada", r.err === "analysis_note_required", JSON.stringify(r));
await as("tec", `select public.finish_evaluation('${e9}', 'analise', 'Motivo de teste')`);
q = (await db.query(`select source, status, send_note from public.repair_analysis_queue where serial='SER9'`)).rows[0];
ok("destino análise técnica entra na fila", q && q.source === "estagio1" && q.status === "aguardando", JSON.stringify(q));
ok("justificativa do Estágio 1 gravada na fila", q?.send_note === "Motivo de teste", JSON.stringify(q));
q = (await db.query(`select count(*)::int c from public.repair_stages where os_id=(select id from public.service_orders where serial='SER9') and stage='manutencao'`)).rows[0].c;
ok("análise técnica não abre o Estágio 2", q === 0);

// vidro
const e10 = await evalOf("SER10", "OS-10");
r = await as("tec2", `select public.finish_evaluation('${e10}', 'vidro')`);
ok("outro técnico não encaminha para vidro", r.err?.includes("sem permissão"));
await as("tec", `select public.finish_evaluation('${e10}', 'vidro')`);
q = (await db.query(`select part, status, origin_stage from public.stock_requests where os_id=(select id from public.service_orders where serial='SER10') order by part`)).rows;
ok("vidro pede Vidro e Aro ao estoque", q.length === 2 && q[0].part === "Aro" && q[1].part === "Vidro" && q.every((x) => x.status === "pendente" && x.origin_stage === "avaliacao"), JSON.stringify(q));
const job = (await db.query(`select id, responsible_id, status from public.repair_glass_jobs where serial='SER10'`)).rows[0];
ok("serviço de vidro aponta o responsável pela desmontagem", job.responsible_id === U.tec && job.status === "aguardando");
r = await as("tec", `select public.start_glass('${job.id}')`);
ok("técnico comum não começa o vidro", r.err?.includes("sem permissão"));
r = await as("est", `select public.start_glass('${job.id}')`);
ok("estoquista não começa o vidro", r.err?.includes("sem permissão"));
r = await as("vid", `select public.finish_glass('${job.id}')`);
ok("não entrega sem começar", r.err?.includes("pedido já fechado"), JSON.stringify(r));
r = await as("vid", `select public.start_glass('${job.id}')`);
ok("técnico de vidro começa o vidro", !r.err, JSON.stringify(r));
let gt = await one("vid", `select public.glass_timer_totals('${job.id}')`);
ok("começar o vidro liga o cronômetro", gt.open_kind === "produtivo", JSON.stringify(gt));
r = await as("tec", `select public.glass_timer_set('${job.id}', 'pausa')`);
ok("técnico comum não mexe no cronômetro do vidro", r.err?.includes("sem permissão"));
await as("vid", `select public.glass_timer_set('${job.id}', 'pausa')`);
gt = await one("vid", `select public.glass_timer_totals('${job.id}')`);
ok("pausar o vidro", gt.open_kind === "pausa", JSON.stringify(gt));
await as("vid", `select public.glass_timer_set('${job.id}', 'produtivo')`);
r = await as("vid", `select public.finish_glass('${job.id}')`);
ok("não entrega sem concluir o vidro", r.err?.includes("pedido já fechado"), JSON.stringify(r));
r = await as("vid", `select public.complete_glass('${job.id}')`);
ok("não conclui o vidro com o vidro ainda pendente no estoque", r.err === "glass_pending", JSON.stringify(r));
const glass = (await db.query(`select id, part from public.stock_requests where os_id=(select id from public.service_orders where serial='SER10')`)).rows;
const vId = glass.find((x) => x.part === "Vidro").id;
const aId = glass.find((x) => x.part === "Aro").id;
await as("est", `select public.deliver_stock_requests($1::jsonb, 'g1')`, [JSON.stringify([{ id: vId }])]);
await as("est", `select public.cancel_stock_request('${aId}','Aro dispensado pelo estoque')`);
r = await as("vid", `select public.complete_glass('${job.id}')`);
ok("com o vidro entregue, conclui o vidro", !r.err, JSON.stringify(r));
gt = await one("vid", `select public.glass_timer_totals('${job.id}')`);
ok("concluir o vidro para o cronômetro", gt.open_kind === null, JSON.stringify(gt));
r = await as("vid", `select public.glass_timer_set('${job.id}', 'produtivo')`);
ok("vidro concluído não aceita cronômetro", r.err?.includes("pedido já fechado"));
r = await as("vid", `select public.finish_glass('${job.id}')`);
ok("com vidro entregue e aro dispensado, entrega ao responsável", !r.err, JSON.stringify(r));
q = (await db.query(`select status, technician_id from public.repair_stages where os_id=(select id from public.service_orders where serial='SER10') and stage='manutencao'`)).rows[0];
ok("o aparelho volta ao Estágio 2 do responsável", q && q.status === "em_andamento" && q.technician_id === U.tec, JSON.stringify(q));
r = await as("vid", `select public.finish_glass('${job.id}')`);
ok("entrega não se repete", r.err?.includes("pedido já fechado"));

// ---- Quarentena: aparelhos enviados pela manutenção esperam o serial ser bipado e marcado
await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('ser20','iPhone 14 128GB-2000','iPhone 14')`);
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER20','OS-20','${U.tec}'), ('SER21','OS-21','${U.tec}')`);
const sendToQuarantine = async (serial) => {
  const st = await one("tec", `select public.start_disassembly('${serial}')`);
  const ev = await one("tec", `select public.finish_disassembly('${st}')`);
  const mt = await one("tec", `select public.finish_evaluation('${ev}')`);
  return one("tec", `select public.finish_maintenance('${mt}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`);
};
ok("manutenção aprovada vai para quarentena (SER20)", (await sendToQuarantine("SER20")) === "quarentena");
ok("manutenção aprovada vai para quarentena (SER21)", (await sendToQuarantine("SER21")) === "quarentena");
r = await as("tec", `select serial, os_number, model, unit, technician from public.quarantine_pending() where serial in ('SER20','SER21') order by serial`);
ok("os dois esperam a quarentena, com modelo e Unit ID", r.rows?.length === 2 && r.rows[0].model === "iPhone 14" && r.rows[0].unit === "iPhone 14 128GB-2000" && r.rows[0].technician === "Tec", JSON.stringify(r));
r = await as("vid", `select count(*)::int from public.quarantine_pending() where serial in ('SER20','SER21')`);
ok("todo mundo com função vê a lista (técnico de vidro)", r.rows?.[0].count === 2, JSON.stringify(r));
r = await as("ana", `select count(*)::int from public.quarantine_pending() where serial in ('SER20','SER21')`);
ok("todo mundo com função vê a lista (analista)", r.rows?.[0].count === 2, JSON.stringify(r));
await db.exec(`insert into public.profiles (id, name, email, role) values ('00000000-0000-0000-0000-000000000008','Sem','s@x','colaborador')`);
U.sem = "00000000-0000-0000-0000-000000000008";
r = await as("sem", `select count(*)::int from public.quarantine_pending()`);
ok("quem está sem função não vê a lista", r.rows?.[0].count === 0, JSON.stringify(r));
r = await as("sem", `insert into public.quarantine_checks (serial, result, user_id) values ('SER20','aprovado','${U.sem}')`);
ok("quem está sem função não registra quarentena", !!r.err);
await db.exec(`insert into public.profiles (id, name, email, role, extra_roles) values ('00000000-0000-0000-0000-000000000007','Mon','m@x','tecnico','{montador}')`);
U.mon = "00000000-0000-0000-0000-000000000007";
r = await as("mon", `insert into public.quarantine_checks (serial, result, user_id) values ('ser20 ','aprovado','${U.mon}')`);
ok("quem tem função (montador somado) registra a quarentena", !r.err, JSON.stringify(r));
r = await as("tec", `select serial from public.quarantine_pending() where serial in ('SER20','SER21')`);
ok("serial bipado e aprovado sai da lista; o outro continua", r.rows?.length === 1 && r.rows[0].serial === "SER21", JSON.stringify(r));
await db.exec(`insert into public.quarantine_checks (serial, result, user_id) values ('SER21','reprovado','${U.mon}')`);
r = await as("tec", `select serial from public.quarantine_pending() where serial in ('SER20','SER21')`);
ok("reprovado também tira da lista", r.rows?.length === 0, JSON.stringify(r));
// um bipe anterior ao envio não conta
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER22','OS-22','${U.tec}')`);
await db.exec(`insert into public.quarantine_checks (serial, result, user_id, created_at) values ('SER22','aprovado','${U.mon}', now() - interval '2 days')`);
await sendToQuarantine("SER22");
r = await as("tec", `select serial from public.quarantine_pending() where serial = 'SER22'`);
ok("resultado antigo, anterior ao envio, não tira da lista", r.rows?.length === 1, JSON.stringify(r));
// OS nova do mesmo serial: a anterior deixa de ser esperada
await db.exec(`insert into public.service_orders (serial, os_number, user_id, created_at) values ('SER22','OS-22B','${U.tec}', now() + interval '1 hour')`);
r = await as("tec", `select serial from public.quarantine_pending() where serial = 'SER22'`);
ok("OS nova do mesmo serial encerra a espera da OS anterior", r.rows?.length === 0, JSON.stringify(r));

// ---- Reprovado na quarentena: nova rodada na mesma OS
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER30','OS-30','${U.tec}')`);
const roundOne = async () => {
  const st = await one("tec", `select public.start_disassembly('SER30')`);
  const ev = await one("tec", `select public.finish_disassembly('${st}')`);
  const mt = await one("tec", `select public.finish_evaluation('${ev}')`);
  const out = await one("tec", `select public.finish_maintenance('${mt}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`);
  return { st, ev, mt, out };
};
const r1 = await roundOne();
ok("rodada 1 vai para a quarentena", r1.out === "quarentena");
r = await as("tec", `select public.redisassembly_allowed('SER30')`);
ok("antes de bipar a quarentena, não pode desmontar de novo", r.rows[0].redisassembly_allowed === false, JSON.stringify(r));
r = await as("tec", `select public.start_disassembly('SER30')`);
ok("start_disassembly repete a mesma etapa enquanto não reprovar", Object.values(r.rows[0])[0] === r1.st, JSON.stringify(r));
await db.exec(`insert into public.quarantine_checks (serial, result, user_id) values ('SER30','aprovado','${U.mon}')`);
r = await as("tec", `select public.redisassembly_allowed('SER30')`);
ok("aprovado na quarentena: não desmonta de novo", r.rows[0].redisassembly_allowed === false);
await new Promise((x) => setTimeout(x, 20));
await db.exec(`insert into public.quarantine_checks (serial, result, user_id) values ('SER30','reprovado','${U.mon}')`);
r = await as("est", `select public.redisassembly_allowed('SER30')`);
ok("estoquista não consulta a permissão", r.rows[0].redisassembly_allowed === false);
r = await as("tec", `select public.redisassembly_allowed('SER30')`);
ok("reprovado na quarentena: pode desmontar de novo", r.rows[0].redisassembly_allowed === true, JSON.stringify(r));
r = await as("tec2", `select public.start_disassembly('SER30')`);
const st2 = Object.values(r.rows[0])[0];
ok("nova desmontagem na MESMA OS, em outra etapa", st2 && st2 !== r1.st, JSON.stringify(r));
q = (await db.query(`select round, status, technician_id from public.repair_stages where id='${st2}'`)).rows[0];
ok("rodada 2 em andamento, com quem reiniciou", q.round === 2 && q.status === "em_andamento" && q.technician_id === U.tec2, JSON.stringify(q));
q = (await db.query(`select count(*)::int c from public.service_orders where serial='SER30'`)).rows[0].c;
ok("nenhuma OS nova foi criada", q === 1);
q = (await db.query(`select status, outcome from public.repair_stages where id='${r1.mt}'`)).rows[0];
ok("a rodada 1 continua intacta no histórico", q.status === "concluida" && q.outcome === "quarentena");
r = await as("tec", `select public.redisassembly_allowed('SER30')`);
ok("com a nova desmontagem aberta, não repete", r.rows[0].redisassembly_allowed === false);
r = await as("tec", `select serial from public.quarantine_pending() where serial = 'SER30'`);
ok("reprovado não fica esperando a quarentena", r.rows.length === 0);
const ev2 = await one("tec2", `select public.finish_disassembly('${st2}')`);
q = (await db.query(`select round, stage from public.repair_stages where id='${ev2}'`)).rows[0];
ok("a avaliação nasce na rodada 2", q.round === 2 && q.stage === "avaliacao", JSON.stringify(q));
const mt2 = await one("tec2", `select public.finish_evaluation('${ev2}')`);
q = (await db.query(`select round, stage from public.repair_stages where id='${mt2}'`)).rows[0];
ok("a manutenção nasce na rodada 2", q.round === 2 && q.stage === "manutencao");
ok("rodada 2 também vai para a quarentena", (await one("tec2", `select public.finish_maintenance('${mt2}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`)) === "quarentena");
r = await as("tec", `select serial from public.quarantine_pending() where serial = 'SER30'`);
ok("a rodada 2 espera a quarentena de novo", r.rows.length === 1, JSON.stringify(r));
q = (await db.query(`select count(*)::int c from public.repair_stages where os_id=(select id from public.service_orders where serial='SER30')`)).rows[0].c;
ok("seis etapas na OS (3 por rodada)", q === 6, String(q));

// ---- Análise técnica
const qrow = async (serial) => (await db.query(`select id, status, source, result from public.repair_analysis_queue where serial='${serial}'`)).rows[0];
const q9 = await qrow("SER9");
r = await as("tec", `select public.start_analysis('${q9.id}')`);
ok("técnico não começa análise", r.err?.includes("sem permissão"));
r = await as("ana", `select public.finish_analysis('${q9.id}', 'reparo_placa')`);
ok("não finaliza sem começar", r.err?.includes("pedido já fechado"), JSON.stringify(r));
r = await as("ana", `select public.start_analysis('${q9.id}')`);
ok("analista começa a análise", !r.err, JSON.stringify(r));
r = await as("ana", `select public.start_analysis('${q9.id}')`);
ok("não começa duas vezes", r.err?.includes("pedido já fechado"));
r = await as("ana", `select public.finish_analysis('${q9.id}', 'troca_periferico', '[]')`);
ok("troca de periférico exige as peças", r.err === "parts_required", JSON.stringify(r));
r = await as("ana", `select public.finish_analysis('${q9.id}', 'outro')`);
ok("resultado inválido recusado", r.err?.includes("dados incompletos"));
await db.exec(`insert into public.profiles (id, name, email, role) values ('00000000-0000-0000-0000-000000000009','Ana2','a2@x','analista')`);
U.ana2 = "00000000-0000-0000-0000-000000000009";
r = await as("ana2", `select public.finish_analysis('${q9.id}', 'reparo_placa')`);
ok("outro analista não finaliza a análise de quem começou", r.err?.includes("sem permissão"));
const parts = JSON.stringify([{ part: "Display", purpose: "definitiva", qty: 2 }, { part: "Bateria", purpose: "teste", qty: 5 }]);
r = await as("ana", `select public.finish_analysis('${q9.id}', 'troca_periferico', $1::jsonb)`, [parts]);
const m9 = r.rows?.[0] && Object.values(r.rows[0])[0];
ok("troca de periférico abre o Estágio 2 do responsável", !!m9, JSON.stringify(r));
q = (await db.query(`select status, technician_id, round from public.repair_stages where id='${m9}'`)).rows[0];
ok("Estágio 2 em andamento com o técnico da desmontagem", q.status === "em_andamento" && q.technician_id === U.tec && q.round === 1, JSON.stringify(q));
q = (await db.query(`select part, purpose, qty, status, requested_by, origin_stage, stage_id from public.stock_requests where stage_id='${m9}' order by part`)).rows;
ok("cria os pedidos (teste sempre 1 unidade) para o estoque", q.length === 2 && q[0].part === "Bateria" && q[0].qty === 1 && q[0].purpose === "teste" && q[1].qty === 2 && q.every((x) => x.status === "pendente" && x.requested_by === U.ana && x.origin_stage === "manutencao"), JSON.stringify(q));
q = await qrow("SER9");
ok("análise concluída com o resultado", q.status === "concluida" && q.result === "troca_periferico");
const reqA = (await db.query(`select id from public.stock_requests where stage_id='${m9}' and part='Display'`)).rows[0].id;
r = await as("tec2", `select public.cancel_stock_request('${reqA}','não é meu')`);
ok("técnico de outra OS não cancela o pedido do analista", r.err?.includes("sem permissão"));
r = await as("tec", `select public.cancel_stock_request('${reqA}','já tem peça no bancada')`);
ok("o técnico responsável cancela o pedido do analista", !r.err, JSON.stringify(r));

// manutenção reprovada entra na fila e volta ao Estágio 2 depois da análise
const q5 = await qrow("SER5");
ok("manutenção reprovada está na fila da Análise", q5 && q5.status === "aguardando" && q5.source === "manutencao", JSON.stringify(q5));
await as("ana", `select public.start_analysis('${q5.id}')`);
r = await as("ana", `select public.finish_analysis('${q5.id}', 'troca_periferico', $1::jsonb)`, [JSON.stringify([{ part: "Câmera traseira", purpose: "definitiva", qty: 1 }])]);
const m5 = r.rows?.[0] && Object.values(r.rows[0])[0];
q = (await db.query(`select status, outcome, failed_tests from public.repair_stages where id='${m5}'`)).rows[0];
ok("troca de periférico reabre a manutenção reprovada", q.status === "em_andamento" && q.outcome === null && q.failed_tests.length === 0, JSON.stringify(q));
const pend5 = (await db.query(`select id from public.stock_requests where stage_id='${m5}' and status='pendente'`)).rows[0].id;
await as("tec", `select public.cancel_stock_request('${pend5}','peça já está na bancada')`);
await as("tec", `select public.save_repair_checklist('${m5}','fechado','{"t3":"fail"}')`);
r = await as("tec", `select public.finish_maintenance('${m5}', array[]::text[], array['t3'], p_analysis_note => 'Motivo de teste')`);
ok("falha de novo na manutenção: volta para a fila", r.rows?.[0] && Object.values(r.rows[0])[0] === "analise", JSON.stringify(r));
q = await qrow("SER5");
ok("a fila recomeça como aguardando (ciclo novo)", q.status === "aguardando" && q.result === null, JSON.stringify(q));

// ---- Cronômetro da Análise técnica
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER40','OS-40','${U.tec}')`);
const e40 = await one("tec", `select public.finish_disassembly('${await one("tec", `select public.start_disassembly('SER40')`)}')`);
await as("tec", `select public.finish_evaluation('${e40}', 'analise', 'Motivo de teste')`);
const a40 = (await db.query(`select id from public.repair_analysis_queue where serial='SER40'`)).rows[0].id;
r = await as("ana", `select public.analysis_timer_set('${a40}', 'produtivo')`);
ok("sem começar a análise ninguém mexe no cronômetro", Boolean(r.err), JSON.stringify(r));
let at = await one("ana", `select public.analysis_timer_totals('${a40}')`);
ok("na fila o cronômetro está zerado e parado", at.open_kind === null && at.produtivo === 0, JSON.stringify(at));
await as("ana", `select public.start_analysis('${a40}')`);
at = await one("ana", `select public.analysis_timer_totals('${a40}')`);
ok("começar a análise liga o cronômetro", at.open_kind === "produtivo", JSON.stringify(at));
r = await as("ana2", `select public.analysis_timer_set('${a40}', 'pausa')`);
ok("outro analista não mexe no cronômetro", r.err?.includes("sem permissão"));
r = await as("tec", `select public.analysis_timer_set('${a40}', 'pausa')`);
ok("técnico não mexe no cronômetro da análise", r.err?.includes("sem permissão"));
r = await as("ana", `select public.analysis_timer_set('${a40}', 'espera_peca')`);
ok("espera de peça não vale na análise", r.err?.includes("dados incompletos"));
await as("ana", `select public.analysis_timer_set('${a40}', 'pausa')`);
at = await one("ana", `select public.analysis_timer_totals('${a40}')`);
ok("pausar muda a sessão aberta", at.open_kind === "pausa", JSON.stringify(at));
await as("ana", `select public.analysis_timer_set('${a40}', 'produtivo')`);
q = (await db.query(`select count(*)::int c, count(*) filter (where ended_at is null)::int abertas from public.repair_timer_sessions where analysis_id='${a40}'`)).rows[0];
ok("sempre uma única sessão aberta", q.abertas === 1 && q.c === 3, JSON.stringify(q));
r = await db.exec(`insert into public.repair_timer_sessions (analysis_id, kind) values ('${a40}','pausa')`).catch((e) => e);
ok("o banco impede duas sessões abertas na análise", r instanceof Error && /unique|duplicate/i.test(r.message), String(r));
r = await db.exec(`insert into public.repair_timer_sessions (kind) values ('pausa')`).catch((e) => e);
ok("a sessão precisa ser de uma etapa ou de uma análise", r instanceof Error, String(r));
r = await as("ana", `select public.finish_analysis('${a40}', 'reparo_placa')`);
ok("reparo em placa não abre o Estágio 2", !r.err && Object.values(r.rows[0])[0] === null, JSON.stringify(r));
q = (await db.query(`select count(*)::int c from public.repair_stages where os_id=(select id from public.service_orders where serial='SER40') and stage='manutencao'`)).rows[0].c;
ok("nenhuma manutenção foi criada para o reparo em placa", q === 0);
at = await one("ana", `select public.analysis_timer_totals('${a40}')`);
ok("finalizar a análise encerra o cronômetro", at.open_kind === null, JSON.stringify(at));
r = await as("ana", `select public.analysis_timer_set('${a40}', 'produtivo')`);
ok("sem fase em andamento não há cronômetro", r.err?.includes("pedido já fechado"), JSON.stringify(r));
const analiseTotal = at.produtivo;

// ---- Reparo em placa (fica na aba Análise técnica, feito pelo mesmo analista)
q = await qrow("SER40");
ok("depois da análise o aparelho espera o reparo em placa", q.status === "concluida" && q.result === "reparo_placa", JSON.stringify(q));
q = (await db.query(`select board_status from public.repair_analysis_queue where id='${a40}'`)).rows[0];
ok("reparo em placa aguardando", q.board_status === "aguardando", JSON.stringify(q));
r = await as("tec", `select public.start_board_repair('${a40}')`);
ok("técnico não inicia o reparo em placa", r.err?.includes("sem permissão"));
r = await as("ana2", `select public.start_board_repair('${a40}')`);
ok("outro analista não inicia o reparo (é de quem fez a análise)", r.err?.includes("sem permissão"));
r = await as("ana", `select public.finish_board_repair('${a40}', 'serviço feito na placa', 'quarentena')`);
ok("não finaliza sem iniciar", r.err?.includes("pedido já fechado"), JSON.stringify(r));
r = await as("ana", `select public.start_board_repair('${a40}')`);
ok("quem fez a análise inicia o reparo em placa", !r.err, JSON.stringify(r));
r = await as("ana", `select public.start_board_repair('${a40}')`);
ok("não inicia duas vezes", r.err?.includes("pedido já fechado"));
let bt = await one("ana", `select public.analysis_timer_totals('${a40}', 'reparo_placa')`);
ok("cronômetro do reparo liga ao iniciar", bt.open_kind === "produtivo", JSON.stringify(bt));
at = await one("ana", `select public.analysis_timer_totals('${a40}')`);
ok("o tempo da análise não se mistura com o do reparo", at.open_kind === null && at.produtivo === analiseTotal, JSON.stringify(at));
r = await as("ana2", `select public.analysis_timer_set('${a40}', 'pausa')`);
ok("outro analista não mexe no cronômetro do reparo", r.err?.includes("sem permissão"));
await as("ana", `select public.analysis_timer_set('${a40}', 'pausa')`);
bt = await one("ana", `select public.analysis_timer_totals('${a40}', 'reparo_placa')`);
ok("pausar o reparo em placa", bt.open_kind === "pausa", JSON.stringify(bt));
await as("ana", `select public.analysis_timer_set('${a40}', 'produtivo')`);
r = await as("ana", `select public.finish_board_repair('${a40}', 'ok', 'quarentena')`);
ok("a observação do serviço é obrigatória", r.err === "note_required", JSON.stringify(r));
r = await as("ana", `select public.finish_board_repair('${a40}', 'serviço feito na placa', 'revenda')`);
ok("destino inválido recusado", r.err?.includes("dados incompletos"));
r = await as("ana2", `select public.finish_board_repair('${a40}', 'serviço feito na placa', 'quarentena')`);
ok("outro analista não finaliza o reparo", r.err?.includes("sem permissão"));
r = await as("ana", `select public.quarantine_pending()`);
ok("antes de finalizar, não está na quarentena", !r.rows.some((x) => JSON.stringify(x).includes("SER40")));
r = await as("ana", `select public.finish_board_repair('${a40}', 'Troca do CI de carga na placa', 'quarentena')`);
const m40 = r.rows?.[0] && Object.values(r.rows[0])[0];
ok("quarentena abre a manutenção do próprio analista (checklists e montagem)", !!m40, JSON.stringify(r));
q = (await db.query(`select status, technician_id, stage from public.repair_stages where id='${m40}'`)).rows[0];
ok("o Estágio 2 fica em nome do analista", q.status === "em_andamento" && q.technician_id === U.ana && q.stage === "manutencao", JSON.stringify(q));
r = await as("tec", `select serial from public.quarantine_pending() where serial = 'SER40'`);
ok("ainda não espera a quarentena (falta checklist e montagem)", r.rows.length === 0, JSON.stringify(r));
r = await as("ana2", `select public.repair_timer_set('${m40}', 'produtivo', 'montagem')`);
ok("outro analista não mexe na montagem", r.err?.includes("sem permissão"));
r = await as("ana", `select public.repair_timer_set('${m40}', 'produtivo', 'montagem')`);
ok("o analista liga o cronômetro da montagem", !r.err, JSON.stringify(r));
r = await as("ana", `select public.save_repair_checklist('${m40}', 'fechado', '{"t3":"ok"}')`);
ok("o analista grava os checklists", !r.err, JSON.stringify(r));
r = await as("ana", `select public.create_stock_request('SER40', 'Parafuso', 'definitiva', 1)`);
const p40 = r.rows?.[0] && Object.values(r.rows[0])[0];
ok("o analista pede peça na manutenção dele", !!p40, JSON.stringify(r));
await as("ana", `select public.cancel_stock_request('${p40}','achei o parafuso')`);
r = await as("ana", `select public.finish_maintenance('${m40}', array[]::text[], array['t3'], p_analysis_note => 'Motivo de teste')`);
ok("finalizando a montagem, vai direto para a quarentena", r.rows?.[0] && Object.values(r.rows[0])[0] === "quarentena", JSON.stringify(r));
bt = await one("ana", `select public.analysis_timer_totals('${a40}', 'reparo_placa')`);
ok("finalizar encerra o cronômetro do reparo", bt.open_kind === null && bt.produtivo >= 0, JSON.stringify(bt));
q = (await db.query(`select board_status, board_destination, board_note from public.repair_analysis_queue where id='${a40}'`)).rows[0];
ok("observação e destino ficam registrados", q.board_status === "concluido" && q.board_destination === "quarentena" && q.board_note === "Troca do CI de carga na placa", JSON.stringify(q));
r = await as("tec", `select serial, technician from public.quarantine_pending() where serial = 'SER40'`);
ok("o aparelho aguarda a quarentena, enviado pelo analista", r.rows.length === 1 && r.rows[0].technician === "Ana", JSON.stringify(r));
r = await as("tec", `select public.finish_board_repair('${a40}', 'serviço feito na placa', 'quarentena')`);
ok("reparo já finalizado não repete", Boolean(r.err));
await db.exec(`insert into public.quarantine_checks (serial, result, user_id) values ('SER40','reprovado','${U.mon}')`);
r = await as("tec", `select public.redisassembly_allowed('SER40')`);
ok("reprovado na quarentena depois do reparo em placa: pode desmontar de novo", r.rows[0].redisassembly_allowed === true, JSON.stringify(r));
r = await as("tec", `select serial from public.quarantine_pending() where serial = 'SER40'`);
ok("e sai da lista de aguardando", r.rows.length === 0);

// reparo em placa -> vidro e -> Estágio 2
const toBoard = async (serial, os) => {
  await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('${serial}','${os}','${U.tec}')`);
  const ev = await one("tec", `select public.finish_disassembly('${await one("tec", `select public.start_disassembly('${serial}')`)}')`);
  await as("tec", `select public.finish_evaluation('${ev}', 'analise', 'Motivo de teste')`);
  const id = (await db.query(`select id from public.repair_analysis_queue where serial='${serial}'`)).rows[0].id;
  await as("ana", `select public.start_analysis('${id}')`);
  await as("ana", `select public.finish_analysis('${id}', 'reparo_placa')`);
  await as("ana", `select public.start_board_repair('${id}')`);
  return id;
};
const b41 = await toBoard("SER41", "OS-41");
await as("ana", `select public.finish_board_repair('${b41}', 'Reballing do chip de áudio', 'vidro')`);
q = (await db.query(`select origin, responsible_id, status from public.repair_glass_jobs where serial='SER41'`)).rows[0];
ok("reparo em placa -> vidro abre o mesmo processo de vidro", q && q.origin === "analise" && q.responsible_id === U.tec && q.status === "aguardando", JSON.stringify(q));
q = (await db.query(`select part from public.stock_requests where os_id=(select id from public.service_orders where serial='SER41') order by part`)).rows;
ok("e pede Vidro e Aro ao estoque", q.length === 2 && q[0].part === "Aro" && q[1].part === "Vidro", JSON.stringify(q));
r = await as("tec", `select serial from public.quarantine_pending() where serial = 'SER41'`);
ok("indo para o vidro, não espera a quarentena", r.rows.length === 0);
const job41 = (await db.query(`select id from public.repair_glass_jobs where serial='SER41'`)).rows[0].id;
await as("vid", `select public.start_glass('${job41}')`);
const g41 = (await db.query(`select id, part from public.stock_requests where os_id=(select id from public.service_orders where serial='SER41')`)).rows;
await as("est", `select public.deliver_stock_requests($1::jsonb, 'g41')`, [JSON.stringify([{ id: g41.find((x) => x.part === "Vidro").id }])]);
await as("est", `select public.cancel_stock_request('${g41.find((x) => x.part === "Aro").id}','Aro dispensado pelo estoque')`);
await as("vid", `select public.complete_glass('${job41}')`);
r = await as("vid", `select public.finish_glass('${job41}')`);
q = r.rows?.[0] && (await db.query(`select status, technician_id from public.repair_stages where id='${Object.values(r.rows[0])[0]}'`)).rows[0];
ok("depois do vidro o aparelho volta ao Estágio 2 do técnico responsável", q && q.status === "em_andamento" && q.technician_id === U.tec, JSON.stringify(r));

const b42 = await toBoard("SER42", "OS-42");
r = await as("ana", `select public.finish_board_repair('${b42}', 'Reparo de trilha na placa', 'estagio2')`);
const m42 = r.rows?.[0] && Object.values(r.rows[0])[0];
q = m42 && (await db.query(`select status, technician_id, stage from public.repair_stages where id='${m42}'`)).rows[0];
ok("reparo em placa -> Estágio 2 (ainda há outro reparo)", q && q.status === "em_andamento" && q.technician_id === U.tec && q.stage === "manutencao", JSON.stringify(r));

// ---- Quem mandou para a análise técnica
q = (await db.query(`select sent_by, sent_at from public.repair_analysis_queue where serial='SER9'`)).rows[0];
ok("o envio do Estágio 1 guarda quem mandou", q.sent_by === U.tec && q.sent_at, JSON.stringify(q));
q = (await db.query(`select sent_by from public.repair_analysis_queue where serial='SER5'`)).rows[0];
ok("a manutenção reprovada guarda quem mandou", q.sent_by === U.tec, JSON.stringify(q));
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER50','OS-50','${U.tec}')`);
const e50 = await one("tec2", `select public.finish_disassembly('${await one("tec2", `select public.start_disassembly('SER50')`)}')`);
await as("tec2", `select public.finish_evaluation('${e50}', 'analise', 'Motivo de teste')`);
q = (await db.query(`select sent_by, technician_id from public.repair_analysis_queue q join public.repair_stages s on s.id = q.stage_id where q.serial='SER50'`)).rows[0];
ok("quem mandou é quem concluiu a avaliação (técnico 2)", q.sent_by === U.tec2 && q.technician_id === U.tec2, JSON.stringify(q));
q = (await db.query(`select sent_at, created_at from public.repair_analysis_queue where serial='SER5'`)).rows[0];
ok("reenvio à fila (segunda reprovação) atualiza quando foi mandado", new Date(q.sent_at) > new Date(q.created_at), JSON.stringify(q));

// ---- O aparelho volta para quem mandou para a análise (mesmo sendo outra pessoa que o técnico da etapa)
await db.exec(`insert into public.profiles (id, name, email, role) values ('00000000-0000-0000-0000-000000000010','Adm','adm@x','admin')`);
U.adm = "00000000-0000-0000-0000-000000000010";
const sentByAdmin = async (serial, os) => {
  await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('${serial}','${os}','${U.tec}')`);
  const ev = await one("tec", `select public.finish_disassembly('${await one("tec", `select public.start_disassembly('${serial}')`)}')`);
  await as("adm", `select public.finish_evaluation('${ev}', 'analise', 'Motivo de teste')`);
  return (await db.query(`select id from public.repair_analysis_queue where serial='${serial}'`)).rows[0].id;
};
const x60 = await sentByAdmin("SER60", "OS-60");
q = (await db.query(`select q.sent_by, s.technician_id from public.repair_analysis_queue q join public.repair_stages s on s.id = q.stage_id where q.id='${x60}'`)).rows[0];
ok("quem mandou (admin) difere do técnico da etapa", q.sent_by === U.adm && q.technician_id === U.tec, JSON.stringify(q));
await as("ana", `select public.start_analysis('${x60}')`);
r = await as("ana", `select public.finish_analysis('${x60}', 'troca_periferico', $1::jsonb)`, [JSON.stringify([{ part: "Bateria", purpose: "teste", qty: 1 }])]);
const m60 = r.rows?.[0] && Object.values(r.rows[0])[0];
q = (await db.query(`select technician_id from public.repair_stages where id='${m60}'`)).rows[0];
ok("troca de periférico devolve ao Estágio 2 de quem mandou", q.technician_id === U.adm, JSON.stringify(q));

const x61 = await sentByAdmin("SER61", "OS-61");
await as("ana", `select public.start_analysis('${x61}')`);
await as("ana", `select public.finish_analysis('${x61}', 'reparo_placa')`);
await as("ana", `select public.start_board_repair('${x61}')`);
r = await as("ana", `select public.finish_board_repair('${x61}', 'Reparo de trilha na placa', 'estagio2')`);
const m61 = r.rows?.[0] && Object.values(r.rows[0])[0];
q = (await db.query(`select technician_id from public.repair_stages where id='${m61}'`)).rows[0];
ok("reparo em placa -> Estágio 2 também volta a quem mandou", q.technician_id === U.adm, JSON.stringify(q));

const x62 = await sentByAdmin("SER62", "OS-62");
await as("ana", `select public.start_analysis('${x62}')`);
await as("ana", `select public.finish_analysis('${x62}', 'reparo_placa')`);
await as("ana", `select public.start_board_repair('${x62}')`);
await as("ana", `select public.finish_board_repair('${x62}', 'Reparo de trilha na placa', 'vidro')`);
q = (await db.query(`select responsible_id from public.repair_glass_jobs where serial='SER62'`)).rows[0];
ok("o vidro pedido pelo reparo em placa entrega a quem mandou", q.responsible_id === U.adm, JSON.stringify(q));

// ---- Peça de teste na Análise técnica
const x70 = await sentByAdmin("SER70", "OS-70");
r = await as("ana", `select public.analysis_request_test_part('${x70}', 'Bateria')`);
ok("sem começar a análise não pede peça", r.err?.includes("pedido já fechado"), JSON.stringify(r));
await as("ana", `select public.start_analysis('${x70}')`);
r = await as("ana2", `select public.analysis_request_test_part('${x70}', 'Bateria')`);
ok("outro analista não pede peça na análise de quem começou", r.err?.includes("sem permissão"));
r = await as("tec", `select public.analysis_request_test_part('${x70}', 'Bateria')`);
ok("técnico não pede peça pela análise", r.err?.includes("sem permissão"));
r = await as("ana", `select public.analysis_request_test_part('${x70}', 'Bateria')`);
const t70a = r.rows?.[0] && Object.values(r.rows[0])[0];
ok("analista pede peça para teste", !!t70a, JSON.stringify(r));
q = (await db.query(`select purpose, qty, origin_stage, analysis_id, requested_by, status from public.stock_requests where id='${t70a}'`)).rows[0];
ok("é teste, 1 unidade, origem análise, do analista", q.purpose === "teste" && q.qty === 1 && q.origin_stage === "analise" && q.analysis_id === x70 && q.requested_by === U.ana && q.status === "pendente", JSON.stringify(q));
at = await one("ana", `select public.analysis_timer_totals('${x70}')`);
ok("pedir peça pausa o cronômetro da análise (espera de peça)", at.open_kind === "espera_peca", JSON.stringify(at));
r = await as("ana", `select public.analysis_request_test_part('${x70}', 'bateria')`);
ok("segunda peça de teste do mesmo tipo é bloqueada", r.code === "23505", JSON.stringify(r));
const t70b = Object.values((await as("ana", `select public.analysis_request_test_part('${x70}', 'Display')`)).rows[0])[0];
await as("ana", `select public.analysis_timer_set('${x70}', 'produtivo')`);
at = await one("ana", `select public.analysis_timer_totals('${x70}')`);
ok("o analista retoma o cronômetro com peça pendente", at.open_kind === "produtivo" && at.espera_peca >= 0, JSON.stringify(at));
r = await as("ana", `select public.finish_analysis('${x70}', 'troca_periferico')`);
ok("não finaliza com peça de teste aberta", r.err === "analysis_parts_pending", JSON.stringify(r));
await as("est", `select public.deliver_stock_requests($1::jsonb, 'k70')`, [JSON.stringify([{ id: t70a }, { id: t70b }])]);
r = await as("ana", `select public.finish_analysis('${x70}', 'troca_periferico')`);
ok("não finaliza com peça de teste entregue sem destino", r.err === "analysis_parts_pending", JSON.stringify(r));
r = await as("ana", `select public.define_test_destiny('${t70b}', 'devolucao', 'Peça não serviu')`);
ok("analista devolve a peça de teste ao estoque", !r.err, JSON.stringify(r));
q = (await db.query(`select status, reason from public.stock_returns where request_id='${t70b}'`)).rows[0];
ok("a devolução espera o estoquista confirmar o recebimento", q && q.status === "aguardando_recebimento" && q.reason === "devolucao_teste", JSON.stringify(q));
r = await as("ana", `select public.define_test_destiny('${t70a}', 'utilizacao_definitiva')`);
ok("analista marca a peça testada como definitiva", !r.err, JSON.stringify(r));
const baixa70 = (await db.query(`select coalesce(sum(stock_effect),0)::int s from public.stock_movements where request_id='${t70a}'`)).rows[0].s;
ok("a definitiva não gera segunda baixa", baixa70 === -1, String(baixa70));
r = await as("ana", `select public.finish_analysis('${x70}', 'troca_periferico')`);
const m70 = r.rows?.[0] && Object.values(r.rows[0])[0];
ok("com peça definitiva, troca de periférico finaliza sem pedir outra peça", !!m70, JSON.stringify(r));
q = (await db.query(`select technician_id, status from public.repair_stages where id='${m70}'`)).rows[0];
ok("o aparelho volta ao Estágio 2 de quem mandou para a análise", q.technician_id === U.adm && q.status === "em_andamento", JSON.stringify(q));
q = (await db.query(`select stage_id from public.stock_requests where id='${t70a}'`)).rows[0];
ok("a peça definitiva acompanha o aparelho no Estágio 2", q.stage_id === m70, JSON.stringify(q));
q = (await db.query(`select count(*)::int c from public.stock_requests where os_id=(select id from public.service_orders where serial='SER70') and analysis_id is null`)).rows[0].c;
ok("nenhum pedido extra foi criado", q === 0, String(q));
r = await as("adm", `select public.finish_maintenance('${m70}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`);
ok("o Estágio 2 só finaliza depois do estoque receber a devolução", r.err === "return_unconfirmed", JSON.stringify(r));

// sem peça definitiva, troca de periférico continua exigindo peça
const x71 = await sentByAdmin("SER71", "OS-71");
await as("ana", `select public.start_analysis('${x71}')`);
const t71 = Object.values((await as("ana", `select public.analysis_request_test_part('${x71}', 'Flash')`)).rows[0])[0];
r = await as("ana2", `select public.cancel_stock_request('${t71}','não é minha')`);
ok("outro analista não cancela a peça pedida na análise", r.err?.includes("sem permissão"));
r = await as("ana", `select public.cancel_stock_request('${t71}','estoque sem peça para teste')`);
ok("o analista cancela a peça que pediu", !r.err, JSON.stringify(r));
r = await as("ana", `select public.finish_analysis('${x71}', 'troca_periferico')`);
ok("sem peça definitiva, troca de periférico exige as peças", r.err === "parts_required", JSON.stringify(r));
r = await as("ana", `select public.finish_analysis('${x71}', 'reparo_placa')`);
ok("com o teste cancelado, reparo em placa finaliza", !r.err, JSON.stringify(r));

// ---- Peça de teste resolveu: usar como definitiva e entregar ao técnico, sem outro pedido
const x72 = await sentByAdmin("SER72", "OS-72");
await as("ana", `select public.start_analysis('${x72}')`);
const t72 = Object.values((await as("ana", `select public.analysis_request_test_part('${x72}', 'Alto-falante')`)).rows[0])[0];
await as("est", `select public.deliver_stock_requests($1::jsonb, 'k72')`, [JSON.stringify([{ id: t72 }])]);
await as("ana", `select public.define_test_destiny('${t72}', 'utilizacao_definitiva')`);
r = await as("ana", `select public.finish_analysis('${x72}', 'troca_periferico', '[]')`);
const m72 = r.rows?.[0] && Object.values(r.rows[0])[0];
q = m72 && (await db.query(`select technician_id, status from public.repair_stages where id='${m72}'`)).rows[0];
ok("peça de teste usada: entrega o aparelho ao técnico (Estágio 2) sem outro pedido", q && q.technician_id === U.adm && q.status === "em_andamento", JSON.stringify(r));

// ---- Peça de teste durante o reparo em placa
const x73 = await sentByAdmin("SER73", "OS-73");
await as("ana", `select public.start_analysis('${x73}')`);
await as("ana", `select public.finish_analysis('${x73}', 'reparo_placa')`);
r = await as("ana", `select public.analysis_request_test_part('${x73}', 'Bateria')`);
ok("antes de iniciar o reparo em placa não pede peça", r.err?.includes("pedido já fechado"), JSON.stringify(r));
await as("ana", `select public.start_board_repair('${x73}')`);
r = await as("ana2", `select public.analysis_request_test_part('${x73}', 'Bateria')`);
ok("outro analista não pede peça no reparo de quem iniciou", r.err?.includes("sem permissão"));
r = await as("ana", `select public.analysis_request_test_part('${x73}', 'Bateria')`);
const t73a = r.rows?.[0] && Object.values(r.rows[0])[0];
ok("durante o reparo em placa o analista pega peça emprestada", !!t73a, JSON.stringify(r));
let bt73 = await one("ana", `select public.analysis_timer_totals('${x73}', 'reparo_placa')`);
ok("pedir peça pausa o cronômetro do reparo (espera de peça)", bt73.open_kind === "espera_peca", JSON.stringify(bt73));
const t73b = Object.values((await as("ana", `select public.analysis_request_test_part('${x73}', 'Conector de carga')`)).rows[0])[0];
r = await as("ana", `select public.finish_board_repair('${x73}', 'Reparo do CI de carga', 'estagio2')`);
ok("o reparo não finaliza com peça de teste pendente", r.err === "analysis_parts_pending", JSON.stringify(r));
await as("est", `select public.deliver_stock_requests($1::jsonb, 'k73')`, [JSON.stringify([{ id: t73a }, { id: t73b }])]);
r = await as("ana", `select public.finish_board_repair('${x73}', 'Reparo do CI de carga', 'estagio2')`);
ok("nem com peça entregue sem destino", r.err === "analysis_parts_pending", JSON.stringify(r));
await as("ana", `select public.define_test_destiny('${t73a}', 'devolucao', 'Peça não serviu')`);
await as("ana", `select public.define_test_destiny('${t73b}', 'utilizacao_definitiva')`);
r = await as("ana", `select public.finish_board_repair('${x73}', 'Reparo do CI de carga', 'estagio2')`);
const m73 = r.rows?.[0] && Object.values(r.rows[0])[0];
ok("com as peças resolvidas, o reparo finaliza", !!m73, JSON.stringify(r));
q = (await db.query(`select stage_id from public.stock_requests where id='${t73b}'`)).rows[0];
ok("a peça usada vai junto com o aparelho para o Estágio 2", q.stage_id === m73, JSON.stringify(q));
q = (await db.query(`select status from public.stock_returns where request_id='${t73a}'`)).rows[0];
ok("a peça devolvida espera o estoquista receber", q.status === "aguardando_recebimento");

// ---- Fim do Estágio 2 com destino Vidro
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER80','OS-80','${U.tec}')`);
const s80 = await one("tec", `select public.start_disassembly('SER80')`);
const m80 = await one("tec", `select public.finish_evaluation('${await one("tec", `select public.finish_disassembly('${s80}')`)}')`);
r = await as("tec", `select public.finish_maintenance('${m80}', array[]::text[], array[]::text[], true, 'cliente quer', '{}', true, p_analysis_note => 'Motivo de teste')`);
ok("vidro e revenda ao mesmo tempo é recusado", r.err?.includes("dados incompletos"), JSON.stringify(r));
r = await as("tec", `select public.finish_maintenance('${m80}', array['t1'], array['t3'], false, null, '{}', true, p_analysis_note => 'Motivo de teste')`);
ok("manutenção finaliza com destino vidro, sem exigir o checklist", r.rows?.[0] && Object.values(r.rows[0])[0] === "vidro", JSON.stringify(r));
q = (await db.query(`select origin, responsible_id, status from public.repair_glass_jobs where serial='SER80'`)).rows[0];
ok("abre o mesmo serviço de vidro, devolvendo a quem fez a manutenção", q && q.origin === "manutencao" && q.responsible_id === U.tec && q.status === "aguardando", JSON.stringify(q));
q = (await db.query(`select part from public.stock_requests where os_id=(select id from public.service_orders where serial='SER80') order by part`)).rows;
ok("pede Vidro e Aro ao estoque", q.length === 2 && q[0].part === "Aro" && q[1].part === "Vidro", JSON.stringify(q));
r = await as("tec", `select serial from public.quarantine_pending() where serial = 'SER80'`);
ok("indo para o vidro, ainda não espera a quarentena", r.rows.length === 0);
q = (await db.query(`select count(*)::int c from public.repair_analysis_queue where serial='SER80'`)).rows[0].c;
ok("vidro não entra na fila de Análise", q === 0);
const job80 = (await db.query(`select id from public.repair_glass_jobs where serial='SER80'`)).rows[0].id;
await as("vid", `select public.start_glass('${job80}')`);
const g80 = (await db.query(`select id, part from public.stock_requests where os_id=(select id from public.service_orders where serial='SER80')`)).rows;
await as("est", `select public.deliver_stock_requests($1::jsonb, 'g80')`, [JSON.stringify(g80.map((x) => ({ id: x.id })))]);
await as("vid", `select public.complete_glass('${job80}')`);
await as("vid", `select public.finish_glass('${job80}')`);
q = (await db.query(`select status, outcome from public.repair_stages where id='${m80}'`)).rows[0];
ok("depois do vidro, a manutenção é reaberta para o técnico", q.status === "em_andamento" && q.outcome === null, JSON.stringify(q));
r = await as("tec", `select public.finish_maintenance('${m80}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`);
ok("e então finaliza para a quarentena", r.rows?.[0] && Object.values(r.rows[0])[0] === "quarentena", JSON.stringify(r));

// ---- Vidro: o display morreu no processo
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER90','OS-90','${U.tec}')`);
const e90 = await one("tec", `select public.finish_disassembly('${await one("tec", `select public.start_disassembly('SER90')`)}')`);
await as("tec", `select public.finish_evaluation('${e90}', 'vidro')`);
const job90 = (await db.query(`select id from public.repair_glass_jobs where serial='SER90'`)).rows[0].id;
await as("vid", `select public.start_glass('${job90}')`);
const g90 = (await db.query(`select id from public.stock_requests where os_id=(select id from public.service_orders where serial='SER90')`)).rows;
await as("est", `select public.deliver_stock_requests($1::jsonb, 'g90')`, [JSON.stringify(g90.map((x) => ({ id: x.id })))]);
await as("vid", `select public.complete_glass('${job90}')`);
r = await as("vid", `select public.finish_glass('${job90}', true)`);
const m90 = r.rows?.[0] && Object.values(r.rows[0])[0];
ok("solicitar display devolve o aparelho ao responsável", !!m90, JSON.stringify(r));
q = (await db.query(`select status, technician_id from public.repair_stages where id='${m90}'`)).rows[0];
ok("o Estágio 2 do técnico que desmontou está aberto", q.status === "em_andamento" && q.technician_id === U.tec, JSON.stringify(q));
q = (await db.query(`select part, purpose, qty, status, stage_id, requested_by from public.stock_requests where os_id=(select id from public.service_orders where serial='SER90') and part='Display'`)).rows[0];
ok("o display é pedido ao estoque, na manutenção do responsável", q && q.purpose === "definitiva" && q.qty === 1 && q.status === "pendente" && q.stage_id === m90 && q.requested_by === U.vid, JSON.stringify(q));
q = (await db.query(`select status, display_requested from public.repair_glass_jobs where id='${job90}'`)).rows[0];
ok("o serviço de vidro registra que o display foi pedido", q.status === "concluido" && q.display_requested === true, JSON.stringify(q));
r = await as("tec", `select public.finish_maintenance('${m90}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`);
ok("o técnico só finaliza depois de receber o display", r.err === "request_pending", JSON.stringify(r));

// ---- Estágio 2: tempo de manutenção e tempo de montagem
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER95','OS-95','${U.tec}')`);
const s95 = await one("tec", `select public.start_disassembly('SER95')`);
const m95 = await one("tec", `select public.finish_evaluation('${await one("tec", `select public.finish_disassembly('${s95}')`)}')`);
r = await as("tec", `select public.repair_timer_set('${s95}', 'produtivo', 'montagem')`);
ok("fase de montagem só vale no Estágio 2", Boolean(r.err), JSON.stringify(r));
r = await as("tec", `select public.repair_timer_set('${m95}', 'produtivo', 'outra')`);
ok("fase inválida recusada", r.err?.includes("dados incompletos"));
await as("tec", `select public.repair_timer_set('${m95}', 'produtivo', 'manutencao')`);
let tm = await one("tec", `select public.repair_timer_totals('${m95}', 'manutencao')`);
let ta = await one("tec", `select public.repair_timer_totals('${m95}', 'montagem')`);
ok("manutenção correndo, montagem parada", tm.open_kind === "produtivo" && ta.open_kind === null, JSON.stringify([tm, ta]));
await as("tec", `select public.repair_timer_set('${m95}', 'produtivo', 'montagem')`);
tm = await one("tec", `select public.repair_timer_totals('${m95}', 'manutencao')`);
ta = await one("tec", `select public.repair_timer_totals('${m95}', 'montagem')`);
ok("começar a montagem para a manutenção (sem contar duas vezes)", tm.open_kind === null && ta.open_kind === "produtivo", JSON.stringify([tm, ta]));
q = (await db.query(`select count(*) filter (where ended_at is null)::int abertas from public.repair_timer_sessions where stage_id='${m95}'`)).rows[0];
ok("uma única sessão aberta na etapa", q.abertas === 1);
await as("tec", `select public.create_stock_request('SER95', 'Bateria', 'definitiva', 1)`);
tm = await one("tec", `select public.repair_timer_totals('${m95}', 'manutencao')`);
ta = await one("tec", `select public.repair_timer_totals('${m95}', 'montagem')`);
ok("pedir peça na montagem vira espera de peça (aparece na manutenção)", tm.open_kind === "espera_peca" && ta.open_kind === null, JSON.stringify([tm, ta]));
await as("tec", `select public.repair_timer_set('${m95}', 'pausa', 'montagem')`);
ta = await one("tec", `select public.repair_timer_totals('${m95}', 'montagem')`);
ok("pausar a montagem", ta.open_kind === "pausa", JSON.stringify(ta));
const all95 = await one("tec", `select public.repair_timer_totals('${m95}')`);
ok("sem fase, os totais continuam da etapa inteira", all95.open_kind === "pausa", JSON.stringify(all95));
r = await as("tec", `select public.repair_timer_set('${s95}', 'produtivo')`);
ok("etapas concluídas continuam recusando o cronômetro", r.err?.includes("etapa já concluída"), JSON.stringify(r));

// ---- Troca de periférico feita pelo próprio analista
const x96 = await sentByAdmin("SER96", "OS-96");
await as("ana", `select public.start_analysis('${x96}')`);
r = await as("ana", `select public.finish_analysis('${x96}', 'troca_periferico', $1::jsonb, true)`, [JSON.stringify([{ part: "Display", purpose: "definitiva", qty: 1 }])]);
const m96 = r.rows?.[0] && Object.values(r.rows[0])[0];
q = m96 && (await db.query(`select technician_id, status from public.repair_stages where id='${m96}'`)).rows[0];
ok("o analista fica com a troca (não volta a quem mandou)", q && q.technician_id === U.ana && q.status === "em_andamento", JSON.stringify(r));
const d96 = (await db.query(`select id, stage_id from public.stock_requests where os_id=(select id from public.service_orders where serial='SER96') and part='Display'`)).rows[0];
ok("a peça pedida já fica na manutenção do analista", d96.stage_id === m96, JSON.stringify(d96));
r = await as("ana", `select public.create_stock_request('SER96', 'Flex Proximidade', 'definitiva', 1)`);
const f96 = r.rows?.[0] && Object.values(r.rows[0])[0];
ok("o analista pede mais peça durante o reparo", !!f96, JSON.stringify(r));
r = await as("ana", `select public.repair_timer_set('${m96}', 'produtivo', 'manutencao')`);
ok("o analista conta o tempo da troca", !r.err, JSON.stringify(r));
await as("est", `select public.deliver_stock_requests($1::jsonb, 'k96')`, [JSON.stringify([{ id: d96.id }, { id: f96 }])]);
r = await as("ana", `select public.finish_maintenance('${m96}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`);
ok("o analista finaliza: aprovado vai para a quarentena", r.rows?.[0] && Object.values(r.rows[0])[0] === "quarentena", JSON.stringify(r));
r = await as("tec", `select serial, technician from public.quarantine_pending() where serial = 'SER96'`);
ok("aguarda a quarentena, enviado pelo analista", r.rows.length === 1 && r.rows[0].technician === "Ana", JSON.stringify(r));

// sem p_self continua voltando a quem mandou
const x97 = await sentByAdmin("SER97", "OS-97");
await as("ana", `select public.start_analysis('${x97}')`);
r = await as("ana", `select public.finish_analysis('${x97}', 'troca_periferico', $1::jsonb)`, [JSON.stringify([{ part: "Display", purpose: "definitiva", qty: 1 }])]);
q = (await db.query(`select technician_id from public.repair_stages where id='${Object.values(r.rows[0])[0]}'`)).rows[0];
ok("sem 'eu mesmo', a troca volta a quem mandou", q.technician_id === U.adm, JSON.stringify(q));

// ---- Contagem de manutenções de quem finaliza
// analista fez placa + usou 1 peça de teste + 2 definitivas (1 substituída por defeito): placa 1 + teste 1 + definitiva 2 = 4
const x98 = await sentByAdmin("SER98", "OS-98");
await as("ana", `select public.start_analysis('${x98}')`);
await as("ana", `select public.finish_analysis('${x98}', 'reparo_placa')`);
await as("ana", `select public.start_board_repair('${x98}')`);
const t98 = Object.values((await as("ana", `select public.analysis_request_test_part('${x98}', 'Bateria')`)).rows[0])[0];
await as("est", `select public.deliver_stock_requests($1::jsonb, 'k98a')`, [JSON.stringify([{ id: t98 }])]);
await as("ana", `select public.define_test_destiny('${t98}', 'utilizacao_definitiva')`);
const m98 = Object.values((await as("ana", `select public.finish_board_repair('${x98}', 'Troca do CI de áudio', 'quarentena')`)).rows[0])[0];
const d98 = Object.values((await as("ana", `select public.create_stock_request('SER98', 'Display', 'definitiva', 2)`)).rows[0])[0];
await as("est", `select public.deliver_stock_requests($1::jsonb, 'k98b')`, [JSON.stringify([{ id: d98 }])]);
const sub98 = Object.values((await as("ana", `select public.request_replacement('${d98}', 1, 'falha_tecnica', 'Display sem imagem')`)).rows[0])[0];
await as("est", `select public.deliver_stock_requests($1::jsonb, 'k98c')`, [JSON.stringify([{ id: sub98 }])]);
const ret98 = (await db.query(`select id from public.stock_returns where request_id='${d98}' and reason='substituicao_defeito'`)).rows[0].id;
await as("est", `select public.confirm_stock_return('${ret98}', 'com_defeito')`);
let items98 = await one("ana", `select public.repair_maintenance_items('${m98}')`);
const count = (items) => items.reduce((n, i) => n + (i.qtd ?? 1), 0);
ok("lista: placa, peça de teste usada e displays (o defeituoso não conta duas vezes)", items98.length === 4 && items98[0].tipo === "placa" && count(items98) === 4, JSON.stringify(items98));
r = await as("ana", `select public.finish_maintenance('${m98}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`);
ok("finaliza para a quarentena", r.rows?.[0] && Object.values(r.rows[0])[0] === "quarentena", JSON.stringify(r));
q = (await db.query(`select maintenance_count, maintenance_items from public.repair_stages where id='${m98}'`)).rows[0];
ok("o total de manutenções fica gravado na etapa (4)", q.maintenance_count === 4 && q.maintenance_items.length === 4, JSON.stringify(q));

// técnico que recebe o aparelho depois da placa de outro (destino Estágio 2) não conta a placa
const x99 = await sentByAdmin("SER99", "OS-99");
await as("ana", `select public.start_analysis('${x99}')`);
await as("ana", `select public.finish_analysis('${x99}', 'reparo_placa')`);
await as("ana", `select public.start_board_repair('${x99}')`);
const m99 = Object.values((await as("ana", `select public.finish_board_repair('${x99}', 'Reparo de trilha', 'estagio2')`)).rows[0])[0];
r = await as("adm", `select public.finish_maintenance('${m99}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`);
q = (await db.query(`select maintenance_count from public.repair_stages where id='${m99}'`)).rows[0];
ok("a placa conta só para quem a reparou", q.maintenance_count === 0, JSON.stringify([r, q]));

// ---- Finalizar o cronômetro (para de contar sem finalizar a etapa)
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER100','OS-100','${U.tec}')`);
const s100 = await one("tec", `select public.start_disassembly('SER100')`);
await as("tec", `select public.repair_timer_set('${s100}', 'produtivo')`);
await as("tec", `select public.repair_timer_set('${s100}', 'fim')`);
let t100 = await one("tec", `select public.repair_timer_totals('${s100}')`);
ok("finalizar para o cronômetro da desmontagem", t100.open_kind === null, JSON.stringify(t100));
q = (await db.query(`select status from public.repair_stages where id='${s100}'`)).rows[0];
ok("a etapa continua em andamento", q.status === "em_andamento");
await as("tec", `select public.repair_timer_set('${s100}', 'produtivo')`);
t100 = await one("tec", `select public.repair_timer_totals('${s100}')`);
ok("dá para retomar depois de finalizar", t100.open_kind === "produtivo");
const m100 = await one("tec", `select public.finish_evaluation('${await one("tec", `select public.finish_disassembly('${s100}')`)}')`);
await as("tec", `select public.repair_timer_set('${m100}', 'produtivo', 'manutencao')`);
await as("tec", `select public.repair_timer_set('${m100}', 'fim', 'montagem')`);
let tm100 = await one("tec", `select public.repair_timer_totals('${m100}', 'manutencao')`);
ok("finalizar a montagem não para a manutenção", tm100.open_kind === "produtivo", JSON.stringify(tm100));
await as("tec", `select public.repair_timer_set('${m100}', 'fim', 'manutencao')`);
tm100 = await one("tec", `select public.repair_timer_totals('${m100}', 'manutencao')`);
ok("finalizar a manutenção (troca de peça) para de contar", tm100.open_kind === null, JSON.stringify(tm100));
r = await as("tec2", `select public.repair_timer_set('${m100}', 'fim', 'manutencao')`);
ok("outro técnico não finaliza o cronômetro", r.err?.includes("sem permissão"));

const x101 = await sentByAdmin("SER101", "OS-101");
await as("ana", `select public.start_analysis('${x101}')`);
await as("ana", `select public.analysis_timer_set('${x101}', 'fim')`);
let a101 = await one("ana", `select public.analysis_timer_totals('${x101}')`);
ok("finalizar o cronômetro da análise", a101.open_kind === null, JSON.stringify(a101));
q = (await db.query(`select status from public.repair_analysis_queue where id='${x101}'`)).rows[0];
ok("a análise continua em andamento", q.status === "em_analise");

await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER102','OS-102','${U.tec}')`);
const e102 = await one("tec", `select public.finish_disassembly('${await one("tec", `select public.start_disassembly('SER102')`)}')`);
await as("tec", `select public.finish_evaluation('${e102}', 'vidro')`);
const j102 = (await db.query(`select id from public.repair_glass_jobs where serial='SER102'`)).rows[0].id;
await as("vid", `select public.start_glass('${j102}')`);
await as("vid", `select public.glass_timer_set('${j102}', 'fim')`);
const g102 = await one("vid", `select public.glass_timer_totals('${j102}')`);
ok("finalizar o cronômetro do vidro", g102.open_kind === null, JSON.stringify(g102));

// ---- Painel da Análise (supervisor e admin)
const range = `current_date - 2, current_date + 2`;
r = await as("tec", `select public.repair_dashboard_summary(${range})`);
ok("técnico não vê o painel", r.rows[0].repair_dashboard_summary === null, JSON.stringify(r));
const sum = await one("sup", `select public.repair_dashboard_summary(${range})`);
ok("supervisor vê os balões", sum && typeof sum.quarentena === "number", JSON.stringify(sum));
const quarentenaSeriais = (await as("sup", `select distinct lower(serial) s from public.repair_dashboard_devices('quarentena', ${range})`)).rows.length;
ok("balão quarentena conta por serial (sem repetir)", sum.quarentena === quarentenaSeriais && sum.quarentena > 0, JSON.stringify([sum.quarentena, quarentenaSeriais]));
ok("balões de vidro e análise técnica têm aparelhos", sum.vidro > 0 && sum.analise > 0, JSON.stringify(sum));
ok("aprovados e reprovados na quarentena", sum.aprovados > 0 && sum.reprovados > 0, JSON.stringify(sum));
const reparos = (await db.query(`select coalesce(sum(maintenance_count),0)::int n from public.repair_stages where stage='manutencao' and status='concluida'`)).rows[0].n;
ok("reparos = soma das manutenções contadas", sum.reparos === reparos && reparos >= 4, JSON.stringify([sum.reparos, reparos]));
r = await as("sup", `select serial, os_number, person, detail from public.repair_dashboard_devices('vidro', ${range})`);
ok("ao clicar no balão: aparelho por aparelho (vidro)", r.rows.length > 0 && r.rows.every((x) => x.serial && x.os_number), JSON.stringify(r.rows.slice(0, 2)));
r = await as("sup", `select * from public.repair_dashboard_devices('reparos', ${range}) where serial = 'SER98'`);
ok("reparos lista o aparelho com as manutenções", r.rows.length === 1 && r.rows[0].detail.startsWith("4 manutenções"), JSON.stringify(r.rows));
r = await as("sup", `select * from public.repair_dashboard_devices('quarentena', current_date + 10, current_date + 20)`);
ok("fora do período não aparece", r.rows.length === 0);

const people = (await as("sup", `select * from public.repair_dashboard_people(${range})`)).rows;
const ana = people.find((x) => x.name === "Ana");
ok("colaborador: analista com manutenções, placas e quarentena", ana && Number(ana.manutencoes) >= 4 && Number(ana.placas) >= 3 && Number(ana.quarentena) >= 2, JSON.stringify(ana));
const tecRow = people.find((x) => x.name === "Tec");
const tecGlass = (await db.query(`select count(distinct serial_key)::int n from public.repair_glass_jobs where requested_by='${U.tec}'`)).rows[0].n;
ok("colaborador: liberou para o vidro (por serial)", tecRow && Number(tecRow.vidro_enviados) === tecGlass && tecGlass >= 3, JSON.stringify([tecRow, tecGlass]));
const tecAnalysis = (await db.query(`select count(distinct st.serial_key)::int n from public.repair_events e join public.repair_stages st on st.id = e.stage_id where e.actor='${U.tec}' and e.action in ('avaliacao_concluida','manutencao_finalizada') and e.detail->>'destino'='analise'`)).rows[0].n;
ok("colaborador: liberou para a análise técnica (por serial)", Number(tecRow.analise_enviados) === tecAnalysis && tecAnalysis >= 2, JSON.stringify([tecRow, tecAnalysis]));
const admRow = people.find((x) => x.name === "Adm");
ok("quem mandou para a análise conta (admin que concluiu a avaliação)", admRow && Number(admRow.analise_enviados) >= 5, JSON.stringify(admRow));
const vid = people.find((x) => x.name === "Vid");
ok("colaborador: técnico de vidro com vidros feitos", vid && Number(vid.vidros) >= 3, JSON.stringify(vid));
r = await as("sup", `select * from public.repair_dashboard_person_daily('${U.ana}', ${range})`);
ok("desempenho diário do colaborador", r.rows.length >= 1 && Number(r.rows[0].manutencoes) >= 4, JSON.stringify(r.rows));
r = await as("sup", `select sum(vidro_enviados)::int n from public.repair_dashboard_person_daily('${U.tec}', ${range})`);
ok("desempenho diário mostra o que liberou para o vidro", r.rows[0].n === tecGlass, JSON.stringify(r.rows));
r = await as("sup", `select sum(analise_enviados)::int n from public.repair_dashboard_person_daily('${U.tec}', ${range})`);
ok("desempenho diário mostra o que liberou para a análise técnica", r.rows[0].n === tecAnalysis, JSON.stringify(r.rows));
r = await as("tec", `select count(*)::int from public.repair_dashboard_people(${range})`);
ok("técnico não vê os colaboradores", r.rows[0].count === 0);

const partRows = (await as("sup", `select * from public.repair_dashboard_parts(${range})`)).rows;
const display = partRows.find((x) => x.part === "Display");
ok("peças: displays definitivos entregues e substituição por defeito", display && Number(display.definitivas) > 0 && Number(display.defeito) >= 1, JSON.stringify(display));
const bateria = partRows.find((x) => x.part === "Bateria");
ok("peças: testes entregues, usados e devolvidos", bateria && Number(bateria.testes) > 0 && Number(bateria.testes_usados) > 0 && Number(bateria.devolvidas) > 0, JSON.stringify(bateria));
r = await as("sup", `select * from public.repair_dashboard_part_devices('display', ${range})`);
ok("ao clicar na peça: aparelho por aparelho", r.rows.length > 0 && r.rows.some((x) => x.detail.startsWith("Defeito")), JSON.stringify(r.rows.slice(0, 3)));

await db.exec(`update public.profiles set extra_roles = '{supervisor}' where id = '${U.tec}'`);
q = (await db.query(`select extra_roles from public.profiles where id='${U.tec}'`)).rows[0];
ok("supervisor pode ser função somada", q.extra_roles.includes("supervisor"), JSON.stringify(q));
await db.exec(`update public.profiles set extra_roles = '{}' where id = '${U.tec}'`);

// ---- Checklist manutenção (aparelhos antigos, sem Estágio 1)
r = await as("tec", `select public.start_legacy_maintenance('ANTIGO0')`);
ok("sem OS não inicia o checklist", r.err === "no_os", JSON.stringify(r));
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('ANTIGO1','OS-A1','${U.tec}'), ('ANTIGO2','OS-A2','${U.tec}'), ('ANTIGO3','OS-A3','${U.tec}'), ('ANTIGO4','OS-A4','${U.tec}')`);
r = await as("est", `select public.start_legacy_maintenance('ANTIGO1')`);
ok("estoquista não faz o checklist", r.err?.includes("sem permissão"));
const l1 = await one("tec", `select public.start_legacy_maintenance('ANTIGO1')`);
q = (await db.query(`select stage, status, legacy, technician_id, round from public.repair_stages where id='${l1}'`)).rows[0];
ok("o checklist abre a manutenção do técnico, marcada como aparelho antigo", q.stage === "manutencao" && q.status === "em_andamento" && q.legacy === true && q.technician_id === U.tec && q.round === 1, JSON.stringify(q));
ok("iniciar de novo devolve o mesmo checklist", (await one("tec", `select public.start_legacy_maintenance('antigo1 ')`)) === l1);
await as("tec", `select public.save_repair_checklist('${l1}', 'fechado', '{"t3":"ok"}')`);
r = await as("tec", `select public.finish_maintenance('${l1}', array[]::text[], array['t3'], p_analysis_note => 'Motivo de teste')`);
ok("tudo aprovado vai para a quarentena", r.rows?.[0] && Object.values(r.rows[0])[0] === "quarentena", JSON.stringify(r));
r = await as("tec", `select serial from public.quarantine_pending() where serial = 'ANTIGO1'`);
ok("e aparece na lista de aguardando da quarentena", r.rows.length === 1);
const l1b = await one("tec", `select public.start_legacy_maintenance('ANTIGO1')`);
q = (await db.query(`select round, status, legacy from public.repair_stages where id='${l1b}'`)).rows[0];
ok("checar de novo na mesma OS abre um checklist novo (rodada seguinte)", l1b !== l1 && q.round === 2 && q.status === "em_andamento" && q.legacy, JSON.stringify(q));
q = (await db.query(`select count(*)::int c from public.service_orders where serial='ANTIGO1'`)).rows[0].c;
ok("sem criar OS nova", q === 1);

const l2 = await one("tec", `select public.start_legacy_maintenance('ANTIGO2')`);
await as("tec", `select public.save_repair_checklist('${l2}', 'fechado', '{"t3":"ok"}')`);
r = await as("tec", `select public.finish_maintenance('${l2}', array[]::text[], array['t3'], false, null, '{}', false, true, p_analysis_note => 'Motivo de teste')`);
ok("análise técnica escolhida mesmo sem reprovação", r.rows?.[0] && Object.values(r.rows[0])[0] === "analise", JSON.stringify(r));
q = (await db.query(`select status, source from public.repair_analysis_queue where serial='ANTIGO2'`)).rows[0];
ok("e entra na fila da Análise técnica", q && q.status === "aguardando" && q.source === "manutencao", JSON.stringify(q));
r = await as("tec", `select public.finish_maintenance('${l2}', array[]::text[], array[]::text[], false, null, '{}', true, true, p_analysis_note => 'Motivo de teste')`);
ok("vidro e análise ao mesmo tempo é recusado", Boolean(r.err), JSON.stringify(r));

const l3 = await one("tec", `select public.start_legacy_maintenance('ANTIGO3')`);
r = await as("tec", `select public.finish_maintenance('${l3}', array[]::text[], array[]::text[], false, null, '{}', true, true, p_analysis_note => 'Motivo de teste')`);
ok("vidro e análise juntos não são aceitos", r.err?.includes("dados incompletos"), JSON.stringify(r));
r = await as("tec", `select public.finish_maintenance('${l3}', array[]::text[], array[]::text[], false, null, '{}', true, p_analysis_note => 'Motivo de teste')`);
ok("vidro a partir do checklist", r.rows?.[0] && Object.values(r.rows[0])[0] === "vidro", JSON.stringify(r));
q = (await db.query(`select origin, responsible_id from public.repair_glass_jobs where serial='ANTIGO3'`)).rows[0];
ok("abre o mesmo serviço de vidro", q && q.origin === "manutencao" && q.responsible_id === U.tec, JSON.stringify(q));

const l4 = await one("tec", `select public.start_legacy_maintenance('ANTIGO4')`);
await as("tec", `select public.save_repair_checklist('${l4}', 'fechado', '{"t3":"fail"}')`);
r = await as("tec", `select public.finish_maintenance('${l4}', array[]::text[], array['t3'], p_analysis_note => 'Motivo de teste')`);
ok("quarentena com teste reprovado vai para a análise técnica", r.rows?.[0] && Object.values(r.rows[0])[0] === "analise", JSON.stringify(r));

await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('ANTIGO5','OS-A5','${U.tec}')`);
await as("tec", `select public.start_disassembly('ANTIGO5')`);
r = await as("tec", `select public.start_legacy_maintenance('ANTIGO5')`);
ok("aparelho com Estágio 1 em andamento não abre o checklist antigo", r.err === "disassembly_open", JSON.stringify(r));
r = await as("tec", `select public.start_legacy_maintenance('SER95')`);
ok("aparelho com manutenção do Reparo em andamento não abre aqui", r.err === "in_repair", JSON.stringify(r));

// ---- Rodapé do técnico: quantos aparelhos ele finalizou
const my = await one("tec", `select public.repair_my_summary(current_date - 1, current_date + 1)`);
const myExpected = (await db.query(`select count(distinct serial_key)::int n, count(distinct serial_key) filter (where outcome='quarentena')::int q, count(distinct serial_key) filter (where outcome='vidro')::int v, count(distinct serial_key) filter (where outcome='analise')::int a from public.repair_stages where technician_id='${U.tec}' and stage='manutencao' and status='concluida'`)).rows[0];
ok("o técnico vê quantos aparelhos finalizou, por destino", my.ativos === myExpected.n && my.quarentena === myExpected.q && my.vidro === myExpected.v && my.analise === myExpected.a && my.ativos > 0, JSON.stringify([my, myExpected]));
const myVid = await one("vid", `select public.repair_my_summary(current_date - 1, current_date + 1)`);
ok("cada um vê só os próprios números", myVid.ativos === 0, JSON.stringify(myVid));
const myOld = await one("tec", `select public.repair_my_summary(current_date - 30, current_date - 20)`);
ok("fora do período não conta", myOld.ativos === 0);

// ---- Revenda com justificativa
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SER3','OS-3','${U.tec}')`);
const b1 = await one("tec", `select public.start_disassembly('SER3')`);
const b2 = await one("tec", `select public.finish_evaluation('${await one("tec", `select public.finish_disassembly('${b1}')`)}')`);
r = await as("tec", `select public.finish_maintenance('${b2}', array[]::text[], array[]::text[], true, 'cliente pediu revenda', p_analysis_note => 'Motivo de teste')`);
ok("revenda com justificativa", r.rows?.[0] && Object.values(r.rows[0])[0] === "revenda", JSON.stringify(r));

// ---- PT (perda total): aprovação pendente para administradores e supervisores
const ptStage = async (serial) => {
  await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('${serial}','OS-${serial}','${U.tec}')`);
  const d = await one("tec", `select public.start_disassembly('${serial}')`);
  return one("tec", `select public.finish_evaluation('${await one("tec", `select public.finish_disassembly('${d}')`)}')`);
};
const pt1 = await ptStage("SERPT1");
r = await as("tec", `select public.finish_maintenance('${pt1}', array['t1'], array['t3'], p_pt => true)`);
ok("PT sem motivo recusado", r.err === "pt_reason_required", JSON.stringify(r));
r = await as("tec", `select public.finish_maintenance('${pt1}', array['t1'], array['t3'], false, 'Placa queimada sem reparo', p_pt => true)`);
ok("PT não exige o checklist e fica pendente", r.rows?.[0] && Object.values(r.rows[0])[0] === "pt", JSON.stringify(r));
const ptReq = (await db.query(`select id, status, reason from public.repair_pt_requests where serial='SERPT1'`)).rows[0];
ok("pedido de PT gravado com o motivo", ptReq?.status === "pendente" && ptReq.reason === "Placa queimada sem reparo", JSON.stringify(ptReq));
r = await as("tec", `select public.decide_pt('${ptReq.id}', true)`);
ok("técnico não aprova PT", !!r.err, JSON.stringify(r));
r = await as("sup", `select public.decide_pt('${ptReq.id}', false)`);
ok("reprovar PT exige comentário", r.err === "pt_note_required", JSON.stringify(r));
r = await as("sup", `select public.decide_pt('${ptReq.id}', false, 'Dá para trocar a placa')`);
ok("supervisor reprova PT", !r.err, JSON.stringify(r));
q = (await db.query(`select status, outcome from public.repair_stages where id='${pt1}'`)).rows[0];
ok("PT reprovado devolve a manutenção ao técnico", q.status === "em_andamento" && q.outcome === null, JSON.stringify(q));
r = await as("tec", `select public.finish_maintenance('${pt1}', array[]::text[], array[]::text[], false, 'Sem placa disponível', p_pt => true)`);
const ptReq2 = (await db.query(`select id from public.repair_pt_requests where serial='SERPT1' and status='pendente'`)).rows[0];
r = await as("sup", `select public.decide_pt('${ptReq2.id}', true)`);
q = (await db.query(`select s.status, s.outcome, p.status ps from public.repair_stages s join public.repair_pt_requests p on p.stage_id = s.id where p.id='${ptReq2.id}'`)).rows[0];
ok("supervisor aprova PT e o aparelho fecha como PT", !r.err && q.status === "concluida" && q.outcome === "pt" && q.ps === "aprovado", JSON.stringify([r, q]));
r = await as("sup", `select public.decide_pt('${ptReq2.id}', false, 'mudei de ideia')`);
ok("PT já decidido não muda", r.err === "pt_closed", JSON.stringify(r));

// ---- Espera de peça termina quando o estoque entrega
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('SERW1','OS-W1','${U.tec}')`);
const partWaitStage = await one("tec", `select public.start_disassembly('SERW1')`);
await as("tec", `select public.repair_timer_set('${partWaitStage}','produtivo')`);
const openKind = async () => (await db.query(`select kind from public.repair_timer_sessions where stage_id='${partWaitStage}' and ended_at is null`)).rows[0]?.kind;
const partWaitA = await one("tec", `select public.create_stock_request('SERW1', 'Bateria', 'definitiva', 1)`);
const partWaitB = await one("tec", `select public.create_stock_request('SERW1', 'Tela', 'definitiva', 1)`);
ok("pedir peça põe o cronômetro em espera de peça", (await openKind()) === "espera_peca", String(await openKind()));
await as("est", `select public.deliver_stock_requests($1::jsonb, 'kw1')`, [JSON.stringify([{ id: partWaitA }])]);
ok("com outro pedido aberto, a espera continua", (await openKind()) === "espera_peca", String(await openKind()));
await as("est", `select public.deliver_stock_requests($1::jsonb, 'kw2')`, [JSON.stringify([{ id: partWaitB }])]);
ok("peças entregues: a espera para e o cronômetro fica pausado", (await openKind()) === "pausa", String(await openKind()));

// ---- Peça de teste usada definitivamente aparece para o estoque (migration 81)
const keptPart = await one("tec", `select public.create_stock_request('SERW1', 'Câmera', 'teste', 1)`);
await as("est", `select public.deliver_stock_requests($1::jsonb, 'kk1')`, [JSON.stringify([{ id: keptPart }])]);
await as("tec", `select public.define_test_destiny('${keptPart}','utilizacao_definitiva')`);
r = await as("est", `select count(*)::int c from public.stock_requests where test_destiny='utilizacao_definitiva' and test_kept_ack_at is null and id='${keptPart}'`);
ok("uso definitivo fica aguardando o estoque", !r.err && r.rows[0].c === 1, JSON.stringify(r));
r = await as("tec", `select public.ack_test_kept('${keptPart}')`);
ok("técnico não dá baixa pelo estoque", !!r.err && /permissão/.test(r.err), JSON.stringify(r));
r = await as("est", `select public.ack_test_kept('${keptPart}')`);
ok("estoquista fica ciente do uso definitivo", !r.err, JSON.stringify(r));
r = await as("est", `select public.ack_test_kept('${keptPart}')`);
ok("ciente de novo não duplica", !r.err, JSON.stringify(r));
q = (await db.query(`select (select test_kept_ack_by from public.stock_requests where id='${keptPart}') = '${U.est}' as who,
  (select count(*)::int from public.stock_movements where request_id='${keptPart}' and kind='baixa_definitiva') as n`)).rows[0];
ok("baixa registra quem viu e uma movimentação só", q.who === true && q.n === 1, JSON.stringify(q));
r = await as("est", `select public.ack_test_kept('${partWaitA}')`);
ok("baixa só vale para peça de teste usada de vez", !!r.err, JSON.stringify(r));

// ---- Vidro e outra manutenção (migration 82)
const eG = await evalOf("SERG1", "OS-G1");
const mG = await one("tec", `select public.finish_evaluation('${eG}', 'manutencao', null, true)`);
q = (await db.query(`select needs_glass from public.repair_stages where id = '${mG}'`)).rows[0];
ok("vidro e outra manutenção: Estágio 2 marcado", q?.needs_glass === true, JSON.stringify(q));
q = (await db.query(`select part, glass, stage_id::text, status from public.stock_requests where serial_key = 'serg1' order by part`)).rows;
ok("Vidro e Aro pedidos já no Estágio 1, presos ao Estágio 2", q.length === 2 && q.every(x => x.glass && x.stage_id === mG && x.status === "pendente"), JSON.stringify(q));
const glassDef = await one("tec", `select public.create_stock_request('SERG1', 'Bateria', 'definitiva', 1)`);
await as("est", `select public.deliver_stock_requests($1::jsonb, 'g82a')`, [JSON.stringify([{ id: glassDef }])]);
q = (await db.query(`select public.repair_finish_blockers(os_id) b from public.repair_stages where id = '${mG}'`)).rows[0];
ok("pedido de vidro em aberto não trava a finalização", Array.isArray(q.b) && q.b.length === 0, JSON.stringify(q));
r = await as("tec", `select public.finish_maintenance('${mG}', array['t1'], array['t3'], p_glass => true)`);
ok("finaliza para o vidro sem checklist, com Vidro e Aro ainda pendentes", !r.err && r.rows[0].finish_maintenance === "vidro", JSON.stringify(r));
q = (await db.query(`select (select count(*)::int from public.stock_requests where serial_key = 'serg1' and glass) n,
  (select count(*)::int from public.repair_glass_jobs where serial_key = 'serg1') jobs,
  (select needs_glass from public.repair_stages where id = '${mG}') flag,
  (select maintenance_count from public.repair_stages where id = '${mG}') cnt`)).rows[0];
ok("não pede Vidro e Aro de novo; abre o serviço de vidro", q.n === 2 && q.jobs === 1 && q.flag === false, JSON.stringify(q));
ok("só a peça do técnico conta como manutenção (vidro não)", q.cnt === 1, JSON.stringify(q));
await as("est", `select public.deliver_stock_requests((select jsonb_agg(jsonb_build_object('id', id)) from public.stock_requests where serial_key = 'serg1' and glass), 'g82b')`);
q = (await db.query(`select public.repair_maintenance_items('${mG}') i`)).rows[0];
ok("peças do vidro entregues continuam fora das manutenções", JSON.stringify(q.i).includes("Bateria") && !JSON.stringify(q.i).includes("Vidro"), JSON.stringify(q));

// Só vidro: como antes (vai direto, pede as peças marcadas como vidro).
const eG2 = await evalOf("SERG2", "OS-G2");
await as("tec", `select public.finish_evaluation('${eG2}', 'vidro')`);
q = (await db.query(`select count(*)::int n, bool_and(glass) g from public.stock_requests where serial_key = 'serg2'`)).rows[0];
ok("só vidro: pede Vidro e Aro (marcados como vidro)", q.n === 2 && q.g === true, JSON.stringify(q));

// Aguardando peças não espera o vidro.
const eG3 = await evalOf("SERG3", "OS-G3");
const g3part = await one("tec", `select public.create_stock_request('SERG3', 'Tela', 'definitiva', 1)`);
const mG3 = await one("tec", `select public.finish_evaluation('${eG3}', 'aguardando_pecas', null, true)`);
await as("est", `select public.deliver_stock_requests($1::jsonb, 'g82c')`, [JSON.stringify([{ id: g3part }])]);
q = (await db.query(`select status from public.repair_stages where id = '${mG3}'`)).rows[0];
ok("aguardando peças abre o Estágio 2 sem esperar o vidro", q.status === "em_andamento", JSON.stringify(q));

// Checklist manutenção: o técnico marca vidro e outra manutenção.
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('ANTIGOG','OS-AG','${U.tec}')`);
const lg = await one("tec", `select public.start_legacy_maintenance('ANTIGOG')`);
r = await as("tec2", `select public.request_glass_parts('${lg}')`);
ok("outro técnico não pede o vidro do checklist alheio", !!r.err, JSON.stringify(r));
r = await as("tec", `select public.request_glass_parts('${lg}')`);
ok("checklist manutenção: pede Vidro e Aro", !r.err, JSON.stringify(r));
await as("tec", `select public.request_glass_parts('${lg}')`);
q = (await db.query(`select count(*)::int n from public.stock_requests where serial_key = 'antigog' and glass`)).rows[0];
ok("pedir de novo não duplica", q.n === 2, JSON.stringify(q));
r = await as("tec", `select public.finish_maintenance('${lg}', array['t1'], array['t3'], p_glass => true)`);
q = (await db.query(`select count(*)::int n from public.stock_requests where serial_key = 'antigog' and glass`)).rows[0];
ok("checklist manutenção vai para o vidro sem pedir de novo", !r.err && q.n === 2, JSON.stringify([r, q]));

// ---- Meta diária (migration 82)
q = await one("tec", `select public.repair_my_goal()`);
ok("meta: conta quarentena e vidro do dia", q && q.meta === 10 && q.vidro >= 2 && q.liberados === q.quarentena + q.vidro, JSON.stringify(q));
r = await as("tec", `select public.set_goal_note('  ok ')`);
ok("justificativa curta é recusada", !!r.err && /goal_note_required/.test(r.err), JSON.stringify(r));
r = await as("tec", `select public.set_goal_note('Muitas peças em falta hoje')`);
await as("tec", `select public.set_goal_note('Muitas peças em falta hoje (2)')`);
q = await one("tec", `select public.repair_my_goal()`);
ok("justificativa salva (e reescrita no mesmo dia)", !r.err && q.justificativa === "Muitas peças em falta hoje (2)", JSON.stringify(q));
r = await as("tec2", `select count(*)::int c from public.repair_goal_notes`);
ok("um técnico não lê a justificativa do outro", !r.err && r.rows[0].c === 0, JSON.stringify(r));
r = await as("tec", `insert into public.repair_goal_notes (user_id, day, note) values ('${U.tec}', current_date - 1, 'direto no banco')`);
ok("justificativa só pela função", !!r.err, JSON.stringify(r));
r = await as("sup", `select * from public.repair_dashboard_person_daily('${U.tec}', current_date - 1, current_date + 1)`);
ok("análise mostra a justificativa no dia", !r.err && r.rows.some(x => x.justificativa === "Muitas peças em falta hoje (2)"), JSON.stringify(r));
r = await as("sup", `select * from public.repair_dashboard_people(current_date - 30, current_date + 1)`);
ok("análise: coluna de peças de teste usadas de vez", !r.err && r.rows.length > 0 && r.rows.every(x => x.testes_usados !== undefined) && r.rows.some(x => Number(x.testes_usados) > 0), JSON.stringify(r.rows?.map(x => [x.name, x.manutencoes, x.testes_usados])));

// ---- Manutenções visíveis (migration 83): o exemplo do estoque
// 10 entregues: 5 de teste (devolvidas) + 5 definitivas; 3 das 5 substituídas por defeito => 5 manutenções.
const eM = await evalOf("SERM1", "OS-M1");
const mM = await one("tec", `select public.finish_evaluation('${eM}')`);
const mParts = [];
for (const part of ["Câmera", "Tela", "Bateria", "Conector", "Alto-falante"]) mParts.push(await one("tec", `select public.create_stock_request('SERM1', $1, 'teste', 1)`, [part]));
const mDef = await one("tec", `select public.create_stock_request('SERM1', 'Flex', 'definitiva', 5)`);
await as("est", `select public.deliver_stock_requests($1::jsonb, 'm83a')`, [JSON.stringify([...mParts, mDef].map(id => ({ id })))]);
for (const id of mParts) await as("tec", `select public.define_test_destiny('${id}', 'devolucao', 'Peça não serviu')`);
const mSub = await one("tec", `select public.request_replacement('${mDef}', 3, 'falha_tecnica', 'Flex com defeito')`);
await as("est", `select public.deliver_stock_requests($1::jsonb, 'm83b')`, [JSON.stringify([{ id: mSub }])]);
for (const row of (await db.query(`select id from public.stock_returns where serial_key = 'serm1'`)).rows) {
  await as("est", `select public.confirm_stock_return('${row.id}', 'funcional', 'm83-${row.id}')`);
}
r = await as("tec", `select public.finish_maintenance('${mM}', array[]::text[], array[]::text[])`);
ok("exemplo: finaliza a manutenção", !r.err, JSON.stringify(r));
q = (await db.query(`select public.repair_stage_parts_flow('${mM}') f, maintenance_count c from public.repair_stages where id = '${mM}'`)).rows[0];
ok("exemplo: 10 entregues, 5 testes devolvidos, 3 substituídas", q.f.entregues === 10 && q.f.devolvidas === 5 && q.f.substituidas === 3, JSON.stringify(q));
ok("exemplo: substituir não soma, são 5 manutenções", q.c === 5, JSON.stringify(q));
q = await one("tec", `select public.repair_my_goal()`);
ok("técnico vê as manutenções de hoje", q.manutencao && q.manutencao.manutencoes >= 5 && q.manutencao.entregues >= 10 && q.manutencao.substituidas >= 3, JSON.stringify(q));
r = await as("sup", `select * from public.repair_dashboard_maintenance(current_date - 1, current_date + 1)`);
ok("análise > manutenções por técnico", !r.err && r.rows.some(x => x.user_id === U.tec && Number(x.manutencoes) >= 5 && Number(x.substituidas) >= 3), JSON.stringify(r));
r = await as("sup", `select * from public.repair_dashboard_maintenance_daily('${U.tec}', current_date - 1, current_date + 1)`);
ok("análise > manutenções por dia", !r.err && r.rows.length >= 1 && Number(r.rows[0].manutencoes) >= 5, JSON.stringify(r));
r = await as("tec", `select count(*)::int c from public.repair_dashboard_maintenance(current_date - 1, current_date + 1)`);
ok("técnico não vê a análise dos outros", !r.err && r.rows[0].c === 0, JSON.stringify(r));

// ---- Produtividade individual (migration 84)
const today = (await db.query(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).rows[0].d;
r = await as("sup", `select * from public.repair_productivity($1::date)`, [today]);
const prodTec = r.rows?.find(x => x.user_id === U.tec);
ok("produtividade: lista o técnico com a meta do dia", !r.err && prodTec && prodTec.meta === 10 && typeof prodTec.batida === "boolean", JSON.stringify(r.err ?? prodTec));
ok("produtividade: meta batida quando liberou 10 ou mais", prodTec && prodTec.batida === (prodTec.liberados >= 10), JSON.stringify(prodTec));
ok("produtividade: traz a justificativa e as manutenções", prodTec && prodTec.justificativa === "Muitas peças em falta hoje (2)" && prodTec.manutencoes >= 5, JSON.stringify(prodTec));
ok("produtividade: técnico sem trabalho também aparece", r.rows?.some(x => x.user_id === U.tec2), JSON.stringify(r.rows?.map(x => x.name)));
r = await as("sup", `select * from public.repair_productivity_devices('${U.tec}', $1::date)`, [today]);
ok("produtividade: aparelhos feitos no dia", !r.err && r.rows.some(x => x.serial === "SERM1" && x.destino === "quarentena" && x.manutencoes === 5 && x.conta_meta === true)
  && r.rows.some(x => x.origem === "Estágio 1" && x.destino === "vidro"), JSON.stringify(r.err ?? r.rows.map(x => [x.serial, x.origem, x.destino, x.manutencoes])));
r = await as("tec", `select count(*)::int c from public.repair_productivity($1::date)`, [today]);
ok("produtividade: técnico não vê a dos outros", !r.err && r.rows[0].c === 0, JSON.stringify(r));

// ---- Destino Bloqueado (migration 85)
const bl1 = await ptStage("SERBL1");
r = await as("tec", `select public.finish_maintenance('${bl1}', array['t1'], array['t3'], p_blocked => true)`);
ok("bloqueado sem motivo recusado", r.err === "blocked_reason_required", JSON.stringify(r));
r = await as("tec", `select public.finish_maintenance('${bl1}', array['t1'], array['t3'], false, 'Bloqueio de conta', p_blocked => true, p_pt => true)`);
ok("bloqueado e PT juntos são recusados", !!r.err, JSON.stringify(r));
r = await as("tec", `select public.finish_maintenance('${bl1}', array['t1'], array['t3'], false, 'Bloqueio de conta iCloud', p_blocked => true)`);
ok("bloqueado não exige o checklist", !r.err && r.rows[0].finish_maintenance === "bloqueado", JSON.stringify(r));
q = (await db.query(`select outcome, resale_reason from public.repair_stages where id = '${bl1}'`)).rows[0];
ok("bloqueado guarda o motivo", q.outcome === "bloqueado" && q.resale_reason === "Bloqueio de conta iCloud", JSON.stringify(q));

// ---- Análise: balão Bloqueados e lista de manutenções (migration 86)
q = await one("sup", `select public.repair_dashboard_summary(current_date - 1, current_date + 1)`);
ok("balão de bloqueados", q && q.bloqueados >= 1, JSON.stringify(q));
r = await as("sup", `select * from public.repair_dashboard_devices('bloqueados', current_date - 1, current_date + 1)`);
ok("bloqueados: aparelho com o motivo", !r.err && r.rows.some(x => x.serial === "SERBL1" && x.detail === "Motivo: Bloqueio de conta iCloud"), JSON.stringify(r));
r = await as("sup", `select * from public.repair_dashboard_devices('reparos', current_date - 1, current_date + 1)`);
ok("reparos feitos: mostra as peças", !r.err && r.rows.some(x => x.serial === "SERM1" && x.detail === "5 manutenções: Flex ×5"), JSON.stringify(r.rows?.map(x => [x.serial, x.detail])));
r = await as("sup", `select * from public.repair_dashboard_maintenance_devices('${U.tec}', current_date - 1, current_date + 1)`);
const m86 = r.rows?.find(x => x.serial === "SERM1");
ok("manutenções aparelho por aparelho", !r.err && m86 && m86.manutencoes === 5 && m86.entregues === 10 && m86.devolvidas === 5 && m86.substituidas === 3 && /Flex/.test(m86.itens), JSON.stringify(m86 ?? r));
ok("lista também os finalizados sem peça", r.rows.some(x => x.manutencoes === 0 && x.itens === null), JSON.stringify(r.rows.map(x => [x.serial, x.manutencoes, x.itens])));
r = await as("tec", `select count(*)::int c from public.repair_dashboard_maintenance_devices('${U.tec}', current_date - 1, current_date + 1)`);
ok("técnico não abre a lista da análise", !r.err && r.rows[0].c === 0, JSON.stringify(r));

// ---- Revenda fora da Análise e da meta (migration 87): SER3 foi finalizado como revenda pelo "tec".
q = (await db.query(`select outcome from public.repair_stages where serial = 'SER3' and stage = 'manutencao'`)).rows[0];
ok("SER3 é revenda", q?.outcome === "revenda", JSON.stringify(q));
r = await as("sup", `select serial from public.repair_dashboard_maintenance_devices('${U.tec}', current_date - 1, current_date + 1)`);
ok("revenda fora da lista de manutenções", !r.err && r.rows.length > 0 && !r.rows.some(x => x.serial === "SER3"), JSON.stringify(r));
r = await as("sup", `select serial from public.repair_productivity_devices('${U.tec}', (now() at time zone 'America/Sao_Paulo')::date)`);
ok("revenda fora da produtividade individual", !r.err && !r.rows.some(x => x.serial === "SER3"), JSON.stringify(r));
const revOnly = (await db.query(`select st.id from public.repair_stages st where st.serial = 'SER3' and st.stage = 'manutencao'`)).rows[0].id;
await db.exec(`update public.repair_stages set technician_id = '${U.sup}' where id = '${revOnly}'`);
r = await as("sup", `select user_id from public.repair_dashboard_people(current_date - 1, current_date + 1)`);
ok("quem só liberou revenda não aparece no Colaborador", !r.err && !r.rows.some(x => x.user_id === U.sup), JSON.stringify(r));
r = await as("sup", `select user_id from public.repair_dashboard_maintenance(current_date - 1, current_date + 1)`);
ok("nem na aba Manutenções", !r.err && !r.rows.some(x => x.user_id === U.sup), JSON.stringify(r));
await db.exec(`update public.repair_stages set technician_id = '${U.tec}' where id = '${revOnly}'`);

// ---- Checklist manutenção começado por outro técnico (migration 88)
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('ANTIGOT','OS-AT','${U.tec}')`);
const lt = await one("tec", `select public.start_legacy_maintenance('ANTIGOT')`);
await as("tec", `select public.save_repair_checklist('${lt}', 'aberto', '{"t1":"ok"}'::jsonb)`);
r = await as("tec2", `select public.start_legacy_maintenance('ANTIGOT')`);
ok("outro técnico bipa: avisa quem começou", r.err === "legacy_other_owner", JSON.stringify(r));
r = await as("tec2", `select public.save_repair_checklist('${lt}', 'aberto', '{"t1":"ok"}'::jsonb)`);
ok("sem aceitar, não mexe no checklist do outro", !!r.err, JSON.stringify(r));
q = (await db.query(`select technician_id::text t from public.repair_stages where id = '${lt}'`)).rows[0];
ok("Não: continua com o dono", q.t === U.tec, JSON.stringify(q));
const lt2 = await one("tec2", `select public.take_legacy_checklist('ANTIGOT')`);
ok("Sim: o mesmo checklist passa para quem bipou", lt2 === lt, JSON.stringify([lt, lt2]));
q = (await db.query(`select (select technician_id::text from public.repair_stages where id = '${lt}') t,
  (select count(*)::int from public.repair_checklist_results where stage_id = '${lt}') n,
  (select detail -> 'marcacoes_anteriores' -> 'aberto' ->> 't1' from public.repair_events where stage_id = '${lt}' and action = 'checklist_manutencao_assumido') old`)).rows[0];
ok("Sim: começa do zero e guarda as marcações anteriores no histórico", q.t === U.tec2 && q.n === 0 && q.old === "ok", JSON.stringify(q));
r = await as("tec2", `select public.start_legacy_maintenance('ANTIGOT')`);
ok("depois de aceitar, bipar de novo abre normal", !r.err && r.rows[0].start_legacy_maintenance === lt, JSON.stringify(r));
await as("tec2", `select public.save_repair_checklist('${lt}', 'aberto', '{"t1":"ok","t2":"ok"}'::jsonb)`);
r = await as("tec2", `select public.finish_maintenance('${lt}', array['t1','t2'], array[]::text[])`);
ok("e grava e finaliza", !r.err && r.rows[0].finish_maintenance === "quarentena", JSON.stringify(r));
r = await as("tec", `select public.take_legacy_checklist('ANTIGOT')`);
ok("não assume checklist já finalizado", r.err === "stage_closed", JSON.stringify(r));

// ---- Vidro direto: o técnico de vidro recebe o aparelho, com ou sem desmontagem (migration 90)
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('GV1','OS-GV1','${U.vid}'),('GV2','OS-GV2','${U.vid}'),('GV3','OS-GV3','${U.vid}')`);
r = await as("tec", `select public.start_glass_flow('GV1', true)`);
ok("técnico comum não começa o fluxo do vidro", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("vid", `select public.start_glass_flow('GV1', null)`);
ok("o fluxo do vidro exige responder a desmontagem", r.err?.includes("dados incompletos"), JSON.stringify(r));
r = await as("vid", `select public.start_glass_flow('SEM-OS', true)`);
ok("sem OS é recusado no vidro", r.err === "no_os", JSON.stringify(r));
const gv1 = await one("vid", `select public.start_glass_flow('GV1', true)`);
ok("técnico de vidro começa com desmontagem", typeof gv1 === "string", JSON.stringify(gv1));
q = (await db.query(`select stage, flow, technician_id, needs_glass, status from public.repair_stages where id='${gv1}'`)).rows[0];
ok("a desmontagem é do técnico de vidro, no fluxo do vidro", q.stage === "desmontagem" && q.flow === "vidro" && q.technician_id === U.vid && q.needs_glass && q.status === "em_andamento", JSON.stringify(q));
q = (await db.query(`select part, glass, origin_stage, status from public.stock_requests where serial='GV1' order by part`)).rows;
ok("pede Vidro e Aro ao estoque já ao começar", q.length === 2 && q[0].part === "Aro" && q[1].part === "Vidro" && q.every((x) => x.glass && x.status === "pendente"), JSON.stringify(q));
ok("repetir devolve a mesma desmontagem", (await one("vid", `select public.start_glass_flow('GV1', true)`)) === gv1);
r = await as("vid", `select public.repair_timer_set('${gv1}','produtivo')`);
ok("técnico de vidro liga o cronômetro da própria desmontagem", !r.err, JSON.stringify(r));
r = await as("tec", `select public.finish_glass_flow_disassembly('${gv1}')`);
ok("outro técnico não conclui a desmontagem do vidro", r.err?.includes("sem permissão"), JSON.stringify(r));
const gj1 = await one("vid", `select public.finish_glass_flow_disassembly('${gv1}')`);
ok("concluir a desmontagem abre o serviço de vidro", typeof gj1 === "string", JSON.stringify(gj1));
q = (await db.query(`select origin, responsible_id, stage_id, status from public.repair_glass_jobs where id='${gj1}'`)).rows[0];
ok("o serviço é do técnico de vidro, origem vidro", q.origin === "vidro" && q.responsible_id === U.vid && q.stage_id === gv1 && q.status === "aguardando", JSON.stringify(q));
ok("Vidro e Aro não são pedidos de novo", (await db.query(`select count(*)::int c from public.stock_requests where serial='GV1'`)).rows[0].c === 2);
ok("o fluxo do vidro não abre avaliação técnica", (await db.query(`select count(*)::int c from public.repair_stages where serial='GV1' and stage='avaliacao'`)).rows[0].c === 0);
ok("a desmontagem fica concluída", (await db.query(`select status from public.repair_stages where id='${gv1}'`)).rows[0].status === "concluida");
r = await as("vid", `select public.start_glass_flow('GV1', false)`);
ok("com o vidro aberto não começa outro fluxo na mesma OS", r.err === "glass_open", JSON.stringify(r));
const gIds = (await db.query(`select id from public.stock_requests where serial='GV1'`)).rows.map((x) => ({ id: x.id }));
await as("est", `select public.deliver_stock_requests($1::jsonb, 'gv1')`, [JSON.stringify(gIds)]);
await as("vid", `select public.start_glass('${gj1}')`);
r = await as("vid", `select public.complete_glass('${gj1}')`);
ok("conclui o vidro do fluxo direto", !r.err, JSON.stringify(r));
const gm1 = await one("vid", `select public.finish_glass('${gj1}')`);
q = (await db.query(`select stage, flow, technician_id, status, round from public.repair_stages where id='${gm1}'`)).rows[0];
ok("entregar abre a manutenção do próprio técnico de vidro", q && q.stage === "manutencao" && q.technician_id === U.vid && q.status === "em_andamento" && q.round === 1, JSON.stringify(q));
r = await as("vid", `select public.save_repair_checklist('${gm1}', 'aberto', '{"t1":"fail"}'::jsonb)`);
ok("técnico de vidro salva o checklist da própria manutenção", !r.err, JSON.stringify(r));
r = await as("vid", `select public.repair_timer_set('${gm1}','produtivo','montagem')`);
ok("técnico de vidro liga o cronômetro da montagem", !r.err, JSON.stringify(r));
r = await as("tec2", `select public.save_repair_checklist('${gm1}', 'aberto', '{"t1":"ok"}'::jsonb)`);
ok("outro técnico não mexe no checklist do técnico de vidro", r.err?.includes("sem permissão"), JSON.stringify(r));

// destino Manutenção: passa para o técnico escolhido
r = await as("vid", `select public.hand_over_maintenance('${gm1}', '${U.tec2}', '  ')`);
ok("direcionar exige o motivo", r.err === "handover_note_required", JSON.stringify(r));
r = await as("vid", `select public.hand_over_maintenance('${gm1}', '${U.est}', 'Display falhou nos testes')`);
ok("só técnico de manutenção recebe o aparelho", r.err === "handover_target_invalid", JSON.stringify(r));
r = await as("vid", `select public.hand_over_maintenance('${gm1}', '${U.vid}', 'Display falhou nos testes')`);
ok("não direciona para si mesmo", r.err === "handover_target_invalid", JSON.stringify(r));
r = await as("tec", `select public.hand_over_maintenance('${gm1}', '${U.tec2}', 'Display falhou nos testes')`);
ok("quem não é dono da etapa não direciona", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("vid", `select public.hand_over_maintenance('${gm1}', '${U.tec2}', '  Display falhou nos testes ')`);
ok("direciona para o técnico escolhido", !r.err, JSON.stringify(r));
q = (await db.query(`select technician_id, handover_from, handover_note, status, (select count(*)::int from public.repair_timer_sessions t where t.stage_id = s.id and t.ended_at is null) abertas from public.repair_stages s where id='${gm1}'`)).rows[0];
ok("a etapa passa para o técnico com o motivo e o cronômetro fechado", q.technician_id === U.tec2 && q.handover_from === U.vid && q.handover_note === "Display falhou nos testes" && q.status === "em_andamento" && q.abertas === 0, JSON.stringify(q));
ok("o direcionamento fica no log", (await db.query(`select count(*)::int c from public.repair_events where stage_id='${gm1}' and action='direcionado_manutencao'`)).rows[0].c === 1);
r = await as("vid", `select public.save_repair_checklist('${gm1}', 'aberto', '{"t1":"ok"}'::jsonb)`);
ok("depois de direcionar, o técnico de vidro não mexe mais", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("tec2", `select public.save_repair_checklist('${gm1}', 'aberto', '{"t1":"ok"}'::jsonb)`);
ok("o técnico escolhido segue com a manutenção", !r.err, JSON.stringify(r));
r = await as("vid", `select name from public.list_maintenance_technicians()`);
ok("lista só os técnicos de manutenção", !r.err && ["Tec", "Tec2"].every((n) => r.rows.some((x) => x.name === n)) && !r.rows.some((x) => ["Est", "Vid", "Ana", "Sup"].includes(x.name)), JSON.stringify(r));
r = await as("est", `select count(*)::int c from public.list_maintenance_technicians()`);
ok("estoquista não lista os técnicos", r.rows[0].c === 0, JSON.stringify(r));

// sem desmontagem: o serviço de vidro abre direto
const gj2 = await one("vid", `select public.start_glass_flow('GV2', false)`);
q = (await db.query(`select origin, responsible_id, stage_id, status from public.repair_glass_jobs where id='${gj2}'`)).rows[0];
ok("sem desmontagem abre o serviço de vidro direto", q.origin === "vidro" && q.responsible_id === U.vid && q.stage_id === null && q.status === "aguardando", JSON.stringify(q));
q = (await db.query(`select part, glass, stage_id from public.stock_requests where serial='GV2' order by part`)).rows;
ok("sem desmontagem também pede Vidro e Aro", q.length === 2 && q.every((x) => x.glass && x.stage_id === null), JSON.stringify(q));
ok("sem desmontagem não cria etapa", (await db.query(`select count(*)::int c from public.repair_stages where serial='GV2'`)).rows[0].c === 0);
const g2Ids = (await db.query(`select id from public.stock_requests where serial='GV2'`)).rows.map((x) => ({ id: x.id }));
await as("est", `select public.deliver_stock_requests($1::jsonb, 'gv2')`, [JSON.stringify(g2Ids)]);
await as("vid", `select public.start_glass('${gj2}')`);
await as("vid", `select public.complete_glass('${gj2}')`);
const gm2 = await one("vid", `select public.finish_glass('${gj2}')`);
q = (await db.query(`select technician_id, status, round from public.repair_stages where id='${gm2}'`)).rows[0];
ok("sem desmontagem, entregar abre a manutenção do técnico de vidro", q && q.technician_id === U.vid && q.status === "em_andamento" && q.round === 1, JSON.stringify(q));
r = await as("vid", `select public.start_glass_flow('GV2', false)`);
ok("OS que já fez o fluxo do vidro pede OS nova", r.err === "os_in_use", JSON.stringify(r));
r = await as("vid", `select public.start_glass_flow('SER1', false)`);
ok("aparelho que já está no Reparo não entra no fluxo do vidro", r.err === "os_in_use", JSON.stringify(r));
await as("vid", `select public.start_glass_flow('GV3', false)`);
r = await as("vid", `select public.start_glass_flow('GV3', false)`);
ok("serviço de vidro aberto não duplica", r.err === "glass_open", JSON.stringify(r));

// ---- Vidro: aparelho que veio do Reparo fica com o técnico de vidro (checklist fechado no vidro) (migration 91)
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('GK1','OS-GK1','${U.tec}')`);
const sk1 = await one("tec", `select public.start_disassembly('GK1')`);
const ek1 = await one("tec", `select public.finish_disassembly('${sk1}')`);
const mk1 = await one("tec", `select public.finish_evaluation('${ek1}')`);
await as("tec", `select public.save_repair_checklist('${mk1}', 'aberto', '{"t1":"ok"}'::jsonb)`);
r = await as("tec", `select public.finish_maintenance('${mk1}', array['t1'], array['t3'], false, null, '{}', true, p_analysis_note => 'Motivo de teste')`);
ok("GK1 vai para o vidro depois da manutenção", r.rows?.[0] && Object.values(r.rows[0])[0] === "vidro", JSON.stringify(r));
const jk1 = (await db.query(`select id from public.repair_glass_jobs where serial='GK1'`)).rows[0].id;
await as("vid", `select public.start_glass('${jk1}')`);
const gk1 = (await db.query(`select id from public.stock_requests where serial='GK1'`)).rows;
await as("est", `select public.deliver_stock_requests($1::jsonb, 'gk1')`, [JSON.stringify(gk1.map((x) => ({ id: x.id })))]);
await as("vid", `select public.complete_glass('${jk1}')`);
r = await as("tec", `select public.finish_glass_keep('${jk1}')`);
ok("só vidro/admin assume o checklist depois do vidro", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("vid", `select public.finish_glass_keep('${jk1}')`);
ok("técnico de vidro assume o checklist", !r.err, JSON.stringify(r));
q = (await db.query(`select status, outcome, technician_id, handover_note from public.repair_stages where id='${mk1}'`)).rows[0];
ok("a manutenção reabre com o técnico de vidro", q.status === "em_andamento" && q.outcome === null && q.technician_id === U.vid && q.handover_note === null, JSON.stringify(q));
q = (await db.query(`select results from public.repair_checklist_results where stage_id='${mk1}' and phase='aberto'`)).rows[0];
ok("as marcações do checklist aberto ficam", q && q.results?.t1 === "ok", JSON.stringify(q));
r = await as("vid", `select public.save_repair_checklist('${mk1}', 'fechado', '{"t1":"ok"}'::jsonb)`);
ok("o técnico de vidro faz o checklist fechado", !r.err, JSON.stringify(r));
r = await as("tec", `select public.save_repair_checklist('${mk1}', 'fechado', '{"t1":"ok"}'::jsonb)`);
ok("quem desmontou não mexe mais depois que o vidro assumiu", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("vid", `select public.hand_over_maintenance('${mk1}', '${U.tec}', 'Falhou o teste de tela')`);
ok("do vidro, dá para voltar para a manutenção escolhendo o técnico", !r.err, JSON.stringify(r));
q = (await db.query(`select technician_id from public.repair_stages where id='${mk1}'`)).rows[0];
ok("o técnico escolhido recebe a manutenção", q.technician_id === U.tec, JSON.stringify(q));

// ---- Limpeza: conta como 1 manutenção, somada às peças (migration 92)
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('CL1','OS-CL1','${U.tec}'),('CL2','OS-CL2','${U.tec}')`);
const mcl1 = await one("tec", `select public.finish_evaluation('${await one("tec", `select public.finish_disassembly('${await one("tec", `select public.start_disassembly('CL1')`)}')`)}')`);
r = await as("tec2", `select public.set_maintenance_cleaning('${mcl1}', true)`);
ok("outro técnico não marca a limpeza", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("tec", `select public.set_maintenance_cleaning('${mcl1}', true)`);
ok("técnico marca a limpeza", !r.err, JSON.stringify(r));
r = await as("tec", `select public.finish_maintenance('${mcl1}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`);
ok("limpeza finaliza para a quarentena", r.rows?.[0] && Object.values(r.rows[0])[0] === "quarentena", JSON.stringify(r));
q = (await db.query(`select maintenance_count, maintenance_items from public.repair_stages where id='${mcl1}'`)).rows[0];
ok("a limpeza conta como 1 manutenção", q.maintenance_count === 1 && q.maintenance_items[0]?.tipo === "limpeza", JSON.stringify(q));
const mcl2 = await one("tec", `select public.finish_evaluation('${await one("tec", `select public.finish_disassembly('${await one("tec", `select public.start_disassembly('CL2')`)}')`)}')`);
await as("tec", `select public.create_stock_request('CL2', 'Bateria', 'definitiva', 1)`);
r = await as("tec", `select public.set_maintenance_cleaning('${mcl2}', true)`);
ok("limpeza e pedido de peça convivem na mesma manutenção", !r.err, JSON.stringify(r));
const rcl2 = (await db.query(`select id from public.stock_requests where serial='CL2'`)).rows.map((x) => ({ id: x.id }));
await as("est", `select public.deliver_stock_requests($1::jsonb, 'cl2')`, [JSON.stringify(rcl2)]);
await as("tec", `select public.finish_maintenance('${mcl2}', array[]::text[], array[]::text[], p_analysis_note => 'Motivo de teste')`);
q = (await db.query(`select maintenance_count from public.repair_stages where id='${mcl2}'`)).rows[0];
ok("limpeza + 1 peça contam 2 manutenções", q.maintenance_count === 2, JSON.stringify(q));

// ---- Auditoria, imutabilidade, permissões diretas e view
r = await db.query(`update public.stock_movements set qty = 9 where id = (select min(id) from public.stock_movements)`).catch(e => e);
ok("movimentações são imutáveis", r instanceof Error && /imutável/.test(r.message));
r = await db.query(`delete from public.repair_events`).catch(e => e);
ok("eventos não podem ser apagados", r instanceof Error && /imutável/.test(r.message));
r = await as("tec", `update public.stock_requests set status='entregue', qty_delivered=qty`);
ok("técnico não grava direto (sem grant)", !!r.err && /permission denied/.test(r.err), JSON.stringify(r));
r = await as("tec", `insert into public.stock_movements (request_id, os_id, serial_key, kind) values ('${tCam}', gen_random_uuid(), 'x', 'entrega')`);
ok("técnico não insere movimentação direto", !!r.err && /permission denied/.test(r.err));
r = await as("tec", `select public.stock_log('${tCam}', null, 'entrega', 1, -1, '{}', 'z')`);
ok("função interna stock_log não é chamável", !!r.err && /permission denied/.test(r.err));
const ev = (await db.query(`select count(*)::int c, count(actor)::int a from public.repair_events`)).rows[0];
ok("auditoria registra usuário em cada evento", ev.c > 10 && ev.c === ev.a, JSON.stringify(ev));
await db.exec(`insert into public.part_requests (os_id, serial, part, kind, status, requested_by) select id,'SER1','Antiga','nova','atendida','${U.tec}' from public.service_orders limit 1`);
q = (await db.query(`select source, count(*)::int c from public.stock_requests_all group by 1 order by 1`)).rows;
ok("view junta legado e v2", q.length === 2 && q.some(x => x.source === "legado" && x.c === 1) && q.some(x => x.source === "v2"), JSON.stringify(q));
r = await as("sup", `select count(*)::int from public.stock_requests`);
ok("supervisor consulta", !r.err && r.rows[0].count > 0, JSON.stringify(r));

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
