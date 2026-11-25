// Testa a migration 108 (Dia Laboratório) num Postgres em WASM, sem tocar no Supabase.
// Uso: npm i --no-save @electric-sql/pglite && node supabase/tests/lab_day.pglite.mjs
// Aplica as migrations 44-108 sobre o mesmo esqueleto mínimo de repair_mvp.pglite.mjs.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";

const MIG = "supabase/migrations/";
const db = new PGlite();

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
  vid: "00000000-0000-0000-0000-000000000005",
  adm: "00000000-0000-0000-0000-000000000006",
  tec3: "00000000-0000-0000-0000-000000000007",
  ana: "00000000-0000-0000-0000-000000000008",
  ana2: "00000000-0000-0000-0000-000000000009",
};
await db.exec(`
  insert into public.profiles (id, name, email, role) values
   ('${U.tec}','Tec','t@x','tecnico'),('${U.tec2}','Tec2','t2@x','tecnico'),
   ('${U.est}','Est','e@x','estoquista'),('${U.sup}','Sup','s@x','supervisor'),('${U.adm}','Adm','a@x','admin');
`);

const NO_LOCK = "20261008000110_legacy_no_balloon_lock.sql";
// A 121 parte do start_legacy_maintenance sem trava (110): é aplicada junto com ela, no fim.
const LINK_OPEN = "20261008000121_link_open_checklist.sql";
const files = readdirSync(MIG)
  .filter((f) => /^2026100800\d{4}_.*\.sql$/.test(f))
  .filter((f) => {
    const n = Number(f.slice(10, 14));
    return n >= 44 && n <= 122;
  })
  // A 110 tira a trava de balão do Checklist manutenção (site oficial ainda sem balões). O fluxo de balões é testado
  // sem ela; no fim, ela é aplicada e o comportamento sem trava é conferido.
  .filter((f) => f !== NO_LOCK && f !== LINK_OPEN)
  .sort();
async function applyAll() {
  for (const f of files) await db.exec(readFileSync(MIG + f, "utf8"));
}
await applyAll();
// Os papéis novos (migration 51) existem a partir daqui.
await db.exec(`insert into public.profiles (id, name, email, role) values ('${U.vid}','Vid','v@x','tecnico_vidro')`);
await db.exec(`insert into public.profiles (id, name, email, role, extra_roles) values ('${U.tec3}','Tec3','t3@x','colaborador', '{tecnico}')`);
await db.exec(`insert into public.profiles (id, name, email, role) values ('${U.ana}','Ana','an@x','analista'),('${U.ana2}','Ana2','an2@x','analista')`);
await applyAll(); // idempotente
console.log(`migrations 44-122 aplicadas (2x, ${files.length} arquivos)`);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + extra}`); };

async function as(user, sql, params = []) {
  await db.exec(`set app.uid = '${U[user]}'; set role authenticated;`);
  try {
    const r = await db.query(sql, params);
    return { rows: r.rows };
  } catch (e) {
    return { err: e.message, code: e.code, detail: e.detail };
  } finally {
    await db.exec(`reset role;`);
  }
}
const one = async (user, sql, params) => { const r = await as(user, sql, params); return r.err ? r : r.rows[0] && Object.values(r.rows[0])[0]; };
const asset = (serial) => db.query(`select * from public.lab_assets where serial_key = lower($1) order by entered_at desc limit 1`, [serial]).then((r) => r.rows[0]);
const balloons = (serial) => db.query(`select * from public.lab_balloons where serial_key = lower($1) order by created_at, id`, [serial]).then((r) => r.rows);
const events = (serial) => db.query(`select kind from public.lab_events where serial_key = lower($1) order by created_at, seq`, [serial]).then((r) => r.rows.map((x) => x.kind));
const goal = (user) => one(user, `select public.lab_my_goal()`);

// Ativos na planilha e OS registradas.
const SERIALS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "A1"];
for (const s of SERIALS) {
  await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('${s.toLowerCase()}', 'U-${s}', 'iPhone 13')`);
  await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('${s}', 'OS-${s}', '${U.tec}')`);
}

// Finaliza o checklist do balão com o destino pedido.
const DEST = {
  quarentena: "",
  vidro: ", p_glass => true",
  analise: ", p_analysis => true, p_analysis_note => 'Motivo de teste'",
  revenda: ", p_resale => true, p_resale_reason => 'cliente quer'",
  pt: ", p_pt => true, p_resale_reason => 'sem conserto'",
  bloqueado: ", p_blocked => true, p_resale_reason => 'bloqueio icloud'",
};
async function openAndFinish(user, serial, destination) {
  const stage = await one(user, `select public.start_legacy_maintenance('${serial}')`);
  if (typeof stage !== "string") return { err: "abrir", stage };
  return as(user, `select public.finish_maintenance('${stage}', array[]::text[], array[]::text[]${DEST[destination]})`);
}

// ---- Permissões
let r = await as("tec", `select * from public.lab_preview(array['L1'])`);
ok("técnico não usa a prévia da entrega", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("tec", `select public.lab_deliver(array['L1'], '${U.tec}')`);
ok("técnico não vincula ativos", r.err?.includes("sem permissão"));
r = await as("vid", `select public.lab_deliver(array['L1'], '${U.tec}')`);
ok("técnico de vidro não vincula ativos", r.err?.includes("sem permissão"));
r = await as("tec", `select * from public.lab_board(now() - interval '1 day', now() + interval '1 day')`);
ok("técnico não vê o acompanhamento", r.err?.includes("sem permissão"));
r = await as("vid", `select * from public.lab_rejected()`);
ok("técnico de vidro não vê os reprovados", r.err?.includes("sem permissão"));
r = await as("tec", `select * from public.lab_assets`);
ok("tabela lab_assets fechada para leitura direta", !!r.err, JSON.stringify(r));
r = await as("tec", `insert into public.lab_balloons (asset_id, serial, technician_id, source) values (gen_random_uuid(), 'X', '${U.tec}', 'entrega')`);
ok("tabela lab_balloons fechada para gravação direta", !!r.err);

// ---- Prévia
r = await as("sup", `select * from public.lab_preview(array['L1', 'NAOEXISTE', 'l1 '])`);
ok("prévia: Unit ID pelo serial", r.rows?.[0]?.found === true && r.rows[0].unit === "U-L1", JSON.stringify(r));
ok("prévia: serial inexistente", r.rows?.[1]?.found === false);
ok("prévia: mantém a ordem e aceita espaços/caixa", r.rows?.[2]?.unit === "U-L1");

// ---- Vincular
r = await as("sup", `select public.lab_deliver(array['L1', 'NAOEXISTE'], '${U.tec}')`);
ok("serial inexistente não é vinculado (erro com o serial)", r.err === "lab_serial_not_found" && r.detail === "NAOEXISTE", JSON.stringify(r));
ok("tudo ou nada: L1 não foi vinculado", (await balloons("L1")).length === 0);
r = await as("sup", `select public.lab_deliver(array['L1'], '${U.est}')`);
ok("só técnico recebe balão", r.err === "lab_technician_invalid", JSON.stringify(r));
r = await as("sup", `select public.lab_deliver(array['L1', 'l1', 'L2', 'L3', 'L4'], '${U.tec}')`);
ok("vincula (duplicado na lista conta uma vez)", !r.err && Object.values(r.rows[0])[0] === 4, JSON.stringify(r));
let a = await asset("L1");
ok("status inicial Aguardando manutenção", a.status === "aguardando_manutencao" && a.technician_id === U.tec && a.unit_id === "U-L1", JSON.stringify(a));
let b = (await balloons("L1"))[0];
ok("registra quem vinculou e quando", b.from_id === U.sup && b.source === "entrega" && b.confirmed_at, JSON.stringify(b));
ok("histórico: entrada e entrega", JSON.stringify(await events("L1")) === JSON.stringify(["entrada", "entrega"]), JSON.stringify(await events("L1")));
r = await as("adm", `select public.lab_deliver(array['L1'], '${U.tec2}')`);
ok("ativo já com outro técnico não é vinculado de novo", r.err === "lab_serial_taken" && r.detail === "L1", JSON.stringify(r));
r = await as("sup", `select holder from public.lab_preview(array['L1'])`);
ok("prévia avisa com quem está", r.rows[0].holder === "Tec", JSON.stringify(r));
r = await as("sup", `select public.lab_deliver(array['L5'], '${U.tec3}')`);
ok("técnico como função extra também recebe", !r.err, JSON.stringify(r));

// ---- Meta do técnico
let g = await goal("tec");
ok("meta = balões (4)", g.meta === 4 && g.finalizados === 0 && g.abertos === 4, JSON.stringify(g));
r = await as("tec", `select * from public.lab_my_balloons()`);
ok("técnico vê os seus balões", r.rows.length === 4 && r.rows.every((x) => x.status === "aberto" && x.unit), JSON.stringify(r));
r = await as("tec2", `select * from public.lab_my_balloons()`);
ok("outro técnico não vê os balões dele", r.rows.length === 0);

// ---- Checklist só pelos balões
r = await as("tec2", `select public.start_legacy_maintenance('L1')`);
ok("sem balão o checklist não abre (diz com quem está)", r.err === "lab_no_balloon" && r.detail === "Tec", JSON.stringify(r));
r = await as("tec", `select public.start_legacy_maintenance('L9')`);
ok("serial sem balão não abre", r.err === "lab_no_balloon", JSON.stringify(r));
const st1 = await one("tec", `select public.start_legacy_maintenance('L1')`);
ok("o balão abre o checklist", typeof st1 === "string", JSON.stringify(st1));
b = (await balloons("L1"))[0];
ok("o balão fica ligado ao checklist", b.stage_id === st1);

// ---- Finalizar (cada destino abate 1)
r = await as("tec", `select public.finish_maintenance('${st1}', array[]::text[], array[]::text[])`);
ok("finaliza para a quarentena", !r.err && Object.values(r.rows[0])[0] === "quarentena", JSON.stringify(r));
a = await asset("L1");
b = (await balloons("L1"))[0];
ok("balão finalizado com o destino", b.status === "finalizado" && b.outcome === "quarentena" && b.finished_at, JSON.stringify(b));
ok("ativo Em quarentena, ainda no laboratório", a.status === "quarentena" && a.exited_at === null && a.last_technician_id === U.tec, JSON.stringify(a));
g = await goal("tec");
ok("meta segue 4, 1 finalizado", g.meta === 4 && g.finalizados === 1 && g.abertos === 3, JSON.stringify(g));
r = await as("tec", `select * from public.lab_my_balloons()`);
ok("o balão some da tela do técnico", r.rows.length === 3 && !r.rows.some((x) => x.serial === "L1"));

r = await openAndFinish("tec", "L2", "pt");
a = await asset("L2");
ok("PT sai do laboratório na hora (sem aprovação)", !r.err && a.status === "pt" && a.exited_at, JSON.stringify([r, a]));
r = await openAndFinish("tec", "L3", "vidro");
a = await asset("L3");
ok("Vidro: ativo em Vidro, no laboratório", !r.err && a.status === "vidro" && a.exited_at === null, JSON.stringify([r, a]));
g = await goal("tec");
ok("3 finalizados de 4", g.meta === 4 && g.finalizados === 3, JSON.stringify(g));

// ---- Quarentena aprovada / reprovada
await db.exec(`insert into public.quarantine_checks (serial, result, user_id) values ('l1 ', 'aprovado', '${U.adm}')`);
a = await asset("L1");
ok("quarentena aprovada: saiu", a.status === "quarentena_aprovada" && a.exited_at, JSON.stringify(a));
r = await as("sup", `select public.lab_deliver(array['L6'], '${U.tec2}')`);
r = await openAndFinish("tec2", "L6", "quarentena");
await db.exec(`insert into public.quarantine_checks (serial, result, user_id) values ('L6', 'reprovado', '${U.adm}')`);
a = await asset("L6");
ok("quarentena reprovada: aguardando redistribuição", a.status === "reprovado_aguardando" && a.exited_at === null && a.rejected_at && a.technician_id === null, JSON.stringify(a));
r = await as("tec2", `select * from public.lab_my_balloons()`);
ok("reprovado não aparece para nenhum técnico", r.rows.length === 0);
r = await as("tec2", `select public.start_legacy_maintenance('L6')`);
ok("reprovado não abre o checklist", r.err === "lab_no_balloon", JSON.stringify(r));
r = await as("sup", `select * from public.lab_rejected()`);
ok("balão Ativos reprovados lista o ativo", r.rows.length === 1 && r.rows[0].serial === "L6" && r.rows[0].last_technician === "Tec2" && r.rows[0].unit === "U-L6", JSON.stringify(r));
const rej = r.rows[0].asset_id;
r = await as("sup", `select public.lab_redistribute(array['${a.id}']::uuid[], '${U.tec}')`);
ok("redistribui para qualquer técnico", !r.err, JSON.stringify(r));
a = await asset("L6");
b = (await balloons("L6")).at(-1);
ok("vira balão normal Aguardando manutenção", a.status === "aguardando_manutencao" && b.technician_id === U.tec && b.source === "redistribuicao" && rej === a.id, JSON.stringify([a, b]));
r = await as("sup", `select * from public.lab_rejected()`);
ok("sai do balão Ativos reprovados", r.rows.length === 0);
r = await as("sup", `select public.lab_redistribute(array['${a.id}']::uuid[], '${U.tec}')`);
ok("não redistribui o que não está reprovado", r.err === "lab_not_rejected", JSON.stringify(r));
ok("histórico guarda a quarentena, a reprovação e a redistribuição",
  JSON.stringify(await events("L6")) === JSON.stringify(["entrada", "entrega", "finalizacao", "quarentena_reprovada", "redistribuicao"]),
  JSON.stringify(await events("L6")));
g = await goal("tec");
ok("redistribuição entra na meta (4 -> 5)", g.meta === 5, JSON.stringify(g));

// ---- Direcionar do Vidro
r = await as("vid", `select public.lab_direct_from_glass(array['L4'], '${U.tec2}')`);
ok("só ativos com status Vidro", r.err === "lab_not_in_glass" && r.detail === "L4", JSON.stringify(r));
let job = (await db.query(`select id, status from public.repair_glass_jobs where serial = 'L3' and status <> 'concluido'`)).rows[0];
ok("o checklist abriu o serviço de vidro", !!job, JSON.stringify(job));
r = await as("tec", `select public.lab_direct_from_glass(array['L3'], '${U.tec2}')`);
ok("técnico não direciona do vidro", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("vid", `select * from public.lab_glass_serials()`);
ok("técnico de vidro vê os ativos em Vidro", r.rows.some((x) => x.serial === "L3"), JSON.stringify(r));
r = await as("vid", `select public.lab_direct_from_glass(array['L3'], '${U.tec2}', true)`);
ok("técnico de vidro direciona", !r.err, JSON.stringify(r));
job = (await db.query(`select status, finished_by, display_requested from public.repair_glass_jobs where id = '${job.id}'`)).rows[0];
ok("serviço de vidro fechado por quem direcionou", job.status === "concluido" && job.finished_by === U.vid && job.display_requested === true, JSON.stringify(job));
b = (await balloons("L3")).at(-1);
ok("vira balão do técnico escolhido", b.technician_id === U.tec2 && b.source === "vidro" && b.from_id === U.vid && b.note?.includes("display"), JSON.stringify(b));
r = await db.query(`select actor_id, detail from public.lab_events where serial_key = 'l3' and kind = 'direcionamento_vidro'`);
ok("histórico registra quem direcionou (técnico de vidro)", r.rows[0]?.actor_id === U.vid && r.rows[0].detail.por === "tecnico_vidro", JSON.stringify(r.rows));
g = await goal("tec2");
ok("direcionamento entra na meta de quem recebe", g.abertos === 1, JSON.stringify(g));
const st3 = await one("tec2", `select public.start_legacy_maintenance('L3')`);
ok("o checklist abre depois do vidro (nova rodada)", typeof st3 === "string" && st3 !== b.stage_id, JSON.stringify(st3));

// Supervisor direciona pela Entrega (ativo em Vidro).
r = await openAndFinish("tec2", "L3", "vidro");
r = await as("sup", `select public.lab_deliver(array['L3'], '${U.tec}')`);
b = (await balloons("L3")).at(-1);
r = await db.query(`select detail from public.lab_events where serial_key = 'l3' and kind = 'direcionamento_vidro' order by created_at desc limit 1`);
ok("supervisor direciona do vidro pela Entrega", b.source === "vidro" && b.technician_id === U.tec && r.rows[0].detail.por === "supervisor", JSON.stringify([b, r.rows]));
ok("serviço de vidro fechado", (await db.query(`select count(*)::int c from public.repair_glass_jobs where serial = 'L3' and status <> 'concluido'`)).rows[0].c === 0);

// ---- Transferência
const st4 = await one("tec", `select public.start_legacy_maintenance('L4')`);
await as("tec", `select public.save_repair_checklist('${st4}', 'aberto', '{"t1":"ok"}'::jsonb)`);
const b4 = (await balloons("L4"))[0];
r = await as("tec", `select public.lab_transfer('${b4.id}', '${U.tec}')`);
ok("não transfere para si mesmo", r.err === "lab_technician_invalid", JSON.stringify(r));
r = await as("tec2", `select public.lab_transfer('${b4.id}', '${U.tec2}')`);
ok("só o dono transfere", r.err === "lab_balloon_closed", JSON.stringify(r));
const gBefore = await goal("tec");
const g2Before = await goal("tec2");
r = await as("tec", `select public.lab_transfer('${b4.id}', '${U.tec2}', 'achei outro defeito')`);
ok("transfere com o checklist em andamento", !r.err, JSON.stringify(r));
const b4new = (await balloons("L4")).at(-1);
ok("quem recebe: balão pendente", b4new.status === "pendente" && b4new.from_id === U.tec && b4new.confirmed_at === null && b4new.stage_id === st4, JSON.stringify(b4new));
a = await asset("L4");
ok("ativo em Transferência pendente", a.status === "transferencia_pendente" && a.technician_id === U.tec2, JSON.stringify(a));
let g1 = await goal("tec");
ok("quem transfere: conta como finalizado e no contador de transferidos",
  g1.finalizados === gBefore.finalizados + 1 && g1.transferidos === 1 && g1.meta === gBefore.meta, JSON.stringify([gBefore, g1]));
let g2 = await goal("tec2");
ok("pendente não conta na meta de quem recebe", g2.pendentes === 1 && g2.meta === g2Before.meta, JSON.stringify([g2Before, g2]));
r = await db.query(`select detail from public.lab_events where serial_key = 'l4' and kind = 'transferencia'`);
ok("histórico guarda o que já foi preenchido", r.rows[0]?.detail.marcacoes?.aberto?.t1 === "ok" && r.rows[0].detail.motivo === "achei outro defeito", JSON.stringify(r.rows));
r = await as("tec2", `select public.start_legacy_maintenance('L4')`);
ok("pendente não pode ser trabalhado", r.err === "lab_transfer_pending", JSON.stringify(r));
r = await as("tec", `select public.save_repair_checklist('${st4}', 'aberto', '{"t1":"fail"}'::jsonb)`);
ok("quem transferiu não marca mais o checklist", !!r.err, JSON.stringify(r));
r = await as("tec", `select public.finish_maintenance('${st4}', array[]::text[], array[]::text[])`);
ok("quem transferiu não finaliza", !!r.err, JSON.stringify(r));
r = await as("tec2", `select * from public.lab_my_balloons()`);
ok("quem recebe vê o balão pendente com o nome", r.rows.some((x) => x.serial === "L4" && x.status === "pendente" && x.from_name === "Tec"), JSON.stringify(r));
r = await as("tec3", `select public.lab_confirm_transfer('${b4new.id}')`);
ok("só quem recebeu confirma", r.err === "lab_balloon_closed", JSON.stringify(r));
r = await as("tec2", `select public.lab_confirm_transfer('${b4new.id}')`);
ok("confirma o recebimento", !r.err, JSON.stringify(r));
g2 = await goal("tec2");
ok("depois da confirmação entra na meta (+1)", g2.abertos === g2Before.abertos + 1 && g2.pendentes === 0 && g2.meta === g2Before.meta + 1, JSON.stringify([g2Before, g2]));
const st4b = await one("tec2", `select public.start_legacy_maintenance('L4')`);
ok("quem recebeu continua o mesmo checklist", st4b === st4, JSON.stringify(st4b));
r = await db.query(`select results from public.repair_checklist_results where stage_id = '${st4}' and phase = 'aberto'`);
ok("as marcações ficam", r.rows[0]?.results?.t1 === "ok", JSON.stringify(r.rows));
r = await as("tec2", `select public.finish_maintenance('${st4}', array[]::text[], array[]::text[], p_resale => true, p_resale_reason => 'cliente quer')`);
a = await asset("L4");
ok("finaliza: revenda sai mas não conta na meta de saída", !r.err && a.status === "revenda" && a.exited_at, JSON.stringify([r, a]));
ok("histórico: transferência e confirmação",
  JSON.stringify(await events("L4")) === JSON.stringify(["entrada", "entrega", "transferencia", "confirmacao", "finalizacao"]), JSON.stringify(await events("L4")));

// ---- Bloqueado e análise técnica
await as("sup", `select public.lab_deliver(array['L7', 'L8'], '${U.tec3}')`);
r = await openAndFinish("tec3", "L7", "bloqueado");
ok("bloqueado sai", !r.err && (await asset("L7")).status === "bloqueado" && (await asset("L7")).exited_at, JSON.stringify(r));
r = await openAndFinish("tec3", "L8", "analise");
a = await asset("L8");
ok("avaliação técnica fica no laboratório", !r.err && a.status === "analise" && a.exited_at === null, JSON.stringify([r, a]));

// ---- PT recusado volta para o técnico
const pt = (await db.query(`select id from public.repair_pt_requests where serial = 'L2' and status = 'pendente'`)).rows[0];
r = await as("sup", `select public.decide_pt('${pt.id}', false, 'dá para consertar')`);
a = await asset("L2");
b = (await balloons("L2")).at(-1);
ok("PT recusado reabre a passagem e volta como balão", !r.err && a.exited_at === null && a.status === "aguardando_manutencao" && b.technician_id === U.tec && b.source === "retorno", JSON.stringify([r, a, b]));

// ---- Admin troca o responsável: o balão vai junto
const st5 = await one("tec3", `select public.start_legacy_maintenance('L5')`);
r = await as("adm", `select public.admin_reassign_checklist('${st5}', '${U.tec}')`);
b = (await balloons("L5")).at(-1);
ok("troca de responsável move o balão", !r.err && b.technician_id === U.tec && b.status === "aberto", JSON.stringify([r, b]));

// ---- Acompanhamento
const range = `now() - interval '1 day', now() + interval '1 day'`;
r = await as("sup", `select * from public.lab_board(${range})`);
const byStatus = (s) => r.rows.filter((x) => x.status === s).length;
ok("painel: entraram (L1-L8)", r.rows.length === 8, JSON.stringify(r.rows.map((x) => [x.serial, x.status])));
ok("painel: saíram pela meta (quarentena aprovada)", byStatus("quarentena_aprovada") === 1);
ok("painel: revenda e bloqueado saem sem contar", byStatus("revenda") === 1 && byStatus("bloqueado") === 1);
r = await as("sup", `select * from public.lab_balloon_report(${range})`);
ok("relatório de balões traz transferido para / recebido de",
  r.rows.some((x) => x.serial === "L4" && x.status === "transferido" && x.transferred_to === "Tec2") &&
  r.rows.some((x) => x.serial === "L4" && x.source === "transferencia" && x.from_name === "Tec"), JSON.stringify(r.rows.filter((x) => x.serial === "L4")));
r = await as("sup", `select kind from public.lab_history('l6')`);
ok("histórico do ativo para o supervisor", r.rows.length === 5);

// ---- Produtividade (Análise)
r = await as("sup", `select * from public.lab_productivity((now() at time zone 'America/Sao_Paulo')::date)`);
const prodTec = r.rows?.find((x) => x.user_id === U.tec);
const goalTec = await goal("tec");
ok("produtividade mostra a meta dos balões", prodTec && prodTec.meta === goalTec.meta && prodTec.finalizados === goalTec.finalizados, JSON.stringify([r, goalTec]));
r = await as("tec", `select * from public.lab_productivity(current_date)`);
ok("técnico não vê a produtividade dos outros", r.rows?.length === 0, JSON.stringify(r));

// ---- Análise técnica como checklist (migration 109)
r = await as("tec", `select public.start_analysis_checklist('L8')`);
ok("técnico não abre o checklist da análise", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("ana", `select public.start_analysis_checklist('L2')`);
ok("ativo no balão de um técnico não abre na análise", r.err === "lab_in_balloon" && r.detail === "Tec", JSON.stringify(r));
ok("L8 está aguardando análise técnica, com fila", (await asset("L8")).status === "analise" &&
  (await db.query(`select status from public.repair_analysis_queue where serial = 'L8'`)).rows[0]?.status === "aguardando");
const an8 = await one("ana", `select public.start_analysis_checklist('L8')`);
ok("analista abre o checklist sem balão", typeof an8 === "string" && (await balloons("L8")).every((x) => x.status === "finalizado"), JSON.stringify([an8, await balloons("L8")]));
ok("abrir de novo retoma o mesmo", (await one("ana", `select public.start_analysis_checklist('l8 ')`)) === an8);
r = await as("ana2", `select public.start_analysis_checklist('L8')`);
ok("outro analista vê quem começou", r.err === "legacy_other_owner" && r.detail === "Ana", JSON.stringify(r));
r = await as("ana2", `select public.take_analysis_checklist('L8')`);
ok("outro analista assume do zero", !r.err, JSON.stringify(r));
r = await as("ana2", `select public.finish_maintenance('${an8}', array[]::text[], array[]::text[])`);
ok("analista finaliza: quarentena", !r.err && Object.values(r.rows[0])[0] === "quarentena", JSON.stringify(r));
ok("fila da análise fechada", (await db.query(`select status from public.repair_analysis_queue where serial = 'L8'`)).rows[0]?.status === "concluida");
a = await asset("L8");
ok("ativo sai de aguardando análise para a quarentena (sem balão)", a.status === "quarentena" && (await balloons("L8")).every((x) => x.status === "finalizado"), JSON.stringify(a));
const gAna = await goal("ana2");
ok("análise não conta na meta de balões", gAna.meta === 0, JSON.stringify(gAna));
const an1 = await one("ana", `select public.start_analysis_checklist('A1')`);
r = await as("ana", `select public.finish_maintenance('${an1}', array[]::text[], array[]::text[], p_pt => true, p_resale_reason => 'sem conserto')`);
ok("ativo fora do Dia Laboratório também passa pela análise", !r.err && !(await asset("A1")), JSON.stringify(r));
r = await as("ana", `select public.take_analysis_checklist('L2')`);
ok("analista não assume checklist de técnico", !!r.err, JSON.stringify(r));

// Transferir para técnico a partir da análise.
r = await as("ana", `select count(*)::int c from public.lab_technicians()`);
ok("analista vê a lista de técnicos", r.rows?.[0]?.c >= 3, JSON.stringify(r));
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('L7', 'OS-L7b', '${U.tec}')`);
const an7 = await one("ana", `select public.start_analysis_checklist('L7')`);
await as("ana", `select public.save_repair_checklist('${an7}', 'aberto', '{"t1":"ok"}'::jsonb)`);
r = await as("tec", `select public.analysis_transfer('${an7}', '${U.tec2}')`);
ok("técnico não usa a transferência da análise", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("ana", `select public.analysis_transfer('${an7}', '${U.est}')`);
ok("só transfere para técnico", r.err === "lab_technician_invalid", JSON.stringify(r));
r = await as("ana", `select public.analysis_transfer('${an7}', '${U.tec2}', 'trocar a bateria')`);
ok("analista transfere para técnico", !r.err, JSON.stringify(r));
b = (await balloons("L7")).at(-1);
a = await asset("L7");
ok("vira balão pendente do técnico, com o checklist", b.status === "pendente" && b.technician_id === U.tec2 && b.from_id === U.ana && b.stage_id === an7 && a.status === "transferencia_pendente", JSON.stringify([b, a]));
r = await as("ana", `select public.finish_maintenance('${an7}', array[]::text[], array[]::text[])`);
ok("analista não finaliza depois de transferir", !!r.err, JSON.stringify(r));
r = await as("tec2", `select public.start_legacy_maintenance('L7')`);
ok("pendente até confirmar", r.err === "lab_transfer_pending", JSON.stringify(r));
r = await as("tec2", `select public.lab_confirm_transfer('${b.id}')`);
const st7 = await one("tec2", `select public.start_legacy_maintenance('L7')`);
ok("técnico confirma e continua o mesmo checklist", !r.err && st7 === an7, JSON.stringify([r, st7]));
r = await db.query(`select results from public.repair_checklist_results where stage_id = '${an7}' and phase = 'aberto'`);
ok("marcações do analista ficam", r.rows[0]?.results?.t1 === "ok", JSON.stringify(r.rows));
r = await as("tec2", `select public.finish_maintenance('${st7}', array[]::text[], array[]::text[])`);
b = (await balloons("L7")).at(-1);
ok("técnico finaliza: abate da meta dele", !r.err && b.status === "finalizado" && (await asset("L7")).status === "quarentena", JSON.stringify([r, b]));

// ---- Admin também recebe balão (pode se escolher na entrega)
r = await as("adm", `select id from public.lab_technicians() where id = '${U.adm}'`);
ok("admin aparece na lista de técnicos", r.rows?.length === 1, JSON.stringify(r));
r = await as("adm", `select public.lab_deliver(array['L9'], '${U.adm}')`);
ok("admin vincula ativo a si mesmo", !r.err, JSON.stringify(r));
r = await as("adm", `select serial from public.lab_my_balloons()`);
ok("o balão aparece para o admin", r.rows?.some((x) => x.serial === "L9"), JSON.stringify(r));
r = await openAndFinish("adm", "L9", "quarentena");
ok("admin finaliza o balão", !r.err && (await balloons("L9")).at(-1).status === "finalizado", JSON.stringify(r));
r = await as("sup", `select id from public.lab_technicians() where id = '${U.sup}'`);
ok("supervisor (sem função de técnico) não aparece", r.rows?.length === 0, JSON.stringify(r));

// ---- Vidro: enviar para si mesmo (admin), ativo do Dia Laboratório e fora dele
await as("adm", `select public.lab_deliver(array['L9'], '${U.tec}')`);
r = await openAndFinish("tec", "L9", "vidro");
let j9 = (await db.query(`select id from public.repair_glass_jobs where serial = 'L9' and status <> 'concluido'`)).rows[0];
r = await as("adm", `select public.lab_direct_from_glass(array['L9'], '${U.adm}')`);
ok("admin direciona do vidro para si mesmo", !r.err && (await balloons("L9")).at(-1).technician_id === U.adm, JSON.stringify([r, j9]));
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('VID1', 'OS-VID1', '${U.tec}')`);
const v1 = await one("adm", `select public.start_glass_flow('VID1', false)`);
const jv = (await db.query(`select id from public.repair_glass_jobs where serial = 'VID1' and status <> 'concluido'`)).rows[0];
r = await as("adm", `select public.glass_send_display('${jv.id}', '${U.adm}')`);
ok("Vidro (fora do Dia Laboratório): admin envia para si mesmo", !r.err, JSON.stringify([v1, r]));
r = await as("vid", `select public.glass_send_display(gen_random_uuid(), '${U.sup}')`);
ok("supervisor sem função de técnico não recebe do vidro", r.err?.includes("handover_target_invalid"), JSON.stringify(r));

// ---- Análise: Reparo em placa com a observação e transferir para si mesmo (migration 112)
for (const sn of ["PB1", "TS1"]) {
  await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('${sn.toLowerCase()}', 'U-${sn}', 'iPhone 11')`);
  await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('${sn}', 'OS-${sn}', '${U.tec}')`);
}
const pb = await one("ana", `select public.start_analysis_checklist('PB1')`);
r = await as("ana", `select public.analysis_set_board_note('${pb}', 'abc')`);
ok("reparo em placa exige a observação", r.err === "board_note_required", JSON.stringify(r));
r = await as("tec", `select public.analysis_set_board_note('${pb}', 'troquei o CI de carga')`);
ok("técnico não grava a observação da análise", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("ana", `select public.analysis_set_board_note('${pb}', 'troquei o CI de carga')`);
ok("analista grava a observação do reparo em placa", !r.err, JSON.stringify(r));
r = await as("ana", `select public.finish_maintenance('${pb}', array[]::text[], array[]::text[], p_glass => true)`);
ok("finaliza com qualquer destino (vidro)", !r.err && Object.values(r.rows[0])[0] === "vidro", JSON.stringify(r));
let qb = (await db.query(`select status, result, board_status, board_by, board_note, board_destination from public.repair_analysis_queue where serial = 'PB1'`)).rows[0];
ok("reparo em placa registrado (conta como placa de quem fez)",
  qb?.result === "reparo_placa" && qb.board_status === "concluido" && qb.board_by === U.ana && qb.board_note === "troquei o CI de carga" && qb.board_destination === "vidro",
  JSON.stringify(qb));
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('PB2', 'OS-PB2', '${U.tec}')`);
const pb2 = await one("ana", `select public.start_analysis_checklist('PB2')`);
r = await as("ana", `select public.finish_maintenance('${pb2}', array[]::text[], array[]::text[])`);
qb = (await db.query(`select result from public.repair_analysis_queue where serial = 'PB2'`)).rows[0];
ok("sem reparo em placa marcado, nada de placa", !r.err && !qb, JSON.stringify([r, qb]));
const ts = await one("adm", `select public.start_analysis_checklist('TS1')`);
r = await as("adm", `select public.analysis_transfer('${ts}', '${U.adm}', 'vou montar eu mesmo')`);
b = (await balloons("TS1")).at(-1);
ok("transferir para si mesmo: balão já aberto, sem confirmação", !r.err && b?.status === "aberto" && b.technician_id === U.adm && b.confirmed_at && b.stage_id === ts, JSON.stringify([r, b]));
r = await as("adm", `select public.start_legacy_maintenance('TS1')`);
ok("e continua o mesmo checklist", !r.err && Object.values(r.rows[0])[0] === ts, JSON.stringify(r));
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('TS2', 'OS-TS2', '${U.tec}')`);
const ts2 = await one("ana", `select public.start_analysis_checklist('TS2')`);
r = await as("ana", `select public.analysis_transfer('${ts2}', '${U.ana}')`);
ok("analista sem função de técnico não transfere para si", r.err === "lab_technician_invalid", JSON.stringify([ts2, r]));

// ---- Destino escolhido: teste reprovado não vai sozinho para a Análise técnica (migration 114)
for (const sn of ["QF1", "QF2"]) {
  await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('${sn.toLowerCase()}', 'U-${sn}', 'iPhone XR')`);
  await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('${sn}', 'OS-${sn}', '${U.tec}')`);
}
await as("sup", `select public.lab_deliver(array['QF1', 'QF2'], '${U.tec}')`);
const qf1 = await one("tec", `select public.start_legacy_maintenance('QF1')`);
await as("tec", `select public.save_repair_checklist('${qf1}', 'aberto', '{"t1":"fail"}'::jsonb)`);
r = await as("tec", `select public.finish_maintenance('${qf1}', array['t1'], array[]::text[], p_quarantine => true)`);
ok("teste reprovado + Quarentena escolhida: vai para a quarentena", !r.err && Object.values(r.rows[0])[0] === "quarentena", JSON.stringify(r));
r = await db.query(`select count(*)::int c from public.repair_analysis_queue where serial = 'QF1'`);
ok("e não entra na fila da Análise técnica", r.rows[0].c === 0, JSON.stringify(r.rows));
ok("a falha fica registrada no checklist", (await db.query(`select failed_tests from public.repair_stages where id = '${qf1}'`)).rows[0].failed_tests.length === 1);
ok("Dia Laboratório: ativo em quarentena", (await asset("QF1")).status === "quarentena");
const qf2 = await one("tec", `select public.start_legacy_maintenance('QF2')`);
r = await as("tec", `select public.finish_maintenance('${qf2}', array[]::text[], array[]::text[], p_quarantine => true, p_glass => true)`);
ok("só um destino por vez", r.err?.includes("dados incompletos"), JSON.stringify(r));
r = await as("tec", `select public.finish_maintenance('${qf2}', array[]::text[], array[]::text[], p_analysis => true, p_analysis_note => 'motivo da análise')`);
ok("Análise técnica escolhida continua funcionando", !r.err && Object.values(r.rows[0])[0] === "analise", JSON.stringify(r));

// ---- Passagem amarrada à OS (migration 115): o mesmo serial só conta de novo com outra OS
await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('os1', 'U-OS1', 'iPhone 14')`);
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('OS1', 'OS-A', '${U.tec}')`);
await as("sup", `select public.lab_deliver(array['OS1'], '${U.tec}')`);
r = await openAndFinish("tec", "OS1", "bloqueado");
ok("bloqueado: passagem saiu", !r.err && (await asset("OS1")).exited_at, JSON.stringify(r));
await as("sup", `select public.lab_deliver(array['OS1'], '${U.tec2}')`);
let passages = (await db.query(`select a.id, a.exited_at, so.os_number from public.lab_assets a left join public.service_orders so on so.id = a.os_id where a.serial_key = 'os1'`)).rows;
ok("voltou com a mesma OS: reabre a mesma passagem (não conta de novo)", passages.length === 1 && passages[0].exited_at === null && passages[0].os_number === "OS-A", JSON.stringify(passages));
r = await openAndFinish("tec2", "OS1", "revenda");
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('OS1', 'OS-B', '${U.tec}')`);
await as("sup", `select public.lab_deliver(array['OS1'], '${U.tec}')`);
passages = (await db.query(`select so.os_number from public.lab_assets a left join public.service_orders so on so.id = a.os_id where a.serial_key = 'os1' order by a.entered_at`)).rows;
ok("com outra OS: passagem nova", passages.length === 2 && passages[1].os_number === "OS-B", JSON.stringify(passages));
r = await as("sup", `select serial, os_number from public.lab_board(now() - interval '1 day', now() + interval '1 day') where serial = 'OS1'`);
ok("acompanhamento traz a OS de cada passagem", r.rows?.length === 2 && r.rows.some((x) => x.os_number === "OS-A") && r.rows.some((x) => x.os_number === "OS-B"), JSON.stringify(r));
r = await as("sup", `select os_number from public.lab_balloon_report(now() - interval '1 day', now() + interval '1 day') where serial = 'OS1'`);
ok("relatório de balões traz a OS", r.rows?.length === 3 && r.rows.filter((x) => x.os_number === "OS-A").length === 2, JSON.stringify(r));

// ---- Vidro e outra manutenção exige o checklist aberto; transferência guarda as manutenções (migration 116)
for (const sn of ["VG1", "VG2", "TR1"]) {
  await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('${sn.toLowerCase()}', 'U-${sn}', 'iPhone 12')`);
  await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('${sn}', 'OS-${sn}', '${U.tec}')`);
}
await as("sup", `select public.lab_deliver(array['VG1', 'VG2', 'TR1'], '${U.tec}')`);
const vg1 = await one("tec", `select public.start_legacy_maintenance('VG1')`);
r = await as("tec", `select public.request_glass_parts('${vg1}')`);
ok("marca vidro e outra manutenção", !r.err, JSON.stringify(r));
r = await as("tec", `select public.finish_maintenance('${vg1}', array['t1'], array[]::text[], p_glass => true)`);
ok("vidro e outra manutenção: sem o checklist aberto não vai para o vidro", r.err === "tests_pending", JSON.stringify(r));
await as("tec", `select public.save_repair_checklist('${vg1}', 'aberto', '{"t1":"ok"}'::jsonb)`);
r = await as("tec", `select public.finish_maintenance('${vg1}', array['t1'], array[]::text[], p_glass => true)`);
ok("com o checklist aberto feito, vai para o vidro", !r.err && Object.values(r.rows[0])[0] === "vidro", JSON.stringify(r));
const vg2 = await one("tec", `select public.start_legacy_maintenance('VG2')`);
r = await as("tec", `select public.finish_maintenance('${vg2}', array['t1'], array[]::text[], p_glass => true)`);
ok("só vidro continua sem checklist", !r.err && Object.values(r.rows[0])[0] === "vidro", JSON.stringify(r));
const tr1 = await one("tec", `select public.start_legacy_maintenance('TR1')`);
await as("tec", `select public.declare_maintenance_items('${tr1}', '[{"nome":"Bateria","qtd":1}]'::jsonb)`);
const btr = (await balloons("TR1")).at(-1);
r = await as("tec", `select public.lab_transfer('${btr.id}', '${U.tec2}', 'falta display')`);
const evTr = (await db.query(`select detail from public.lab_events where serial_key = 'tr1' and kind = 'transferencia'`)).rows[0];
ok("transferência guarda as manutenções de quem transferiu", !r.err && evTr?.detail?.manutencoes?.[0]?.nome === "Bateria", JSON.stringify([r, evTr]));

await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('vg3', 'U-VG3', 'iPhone 12')`);
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('VG3', 'OS-VG3', '${U.tec}')`);
await as("sup", `select public.lab_deliver(array['VG3'], '${U.tec}')`);
const vg3 = await one("tec", `select public.start_legacy_maintenance('VG3')`);
await as("tec", `select public.request_glass_parts('${vg3}')`);
await as("tec", `select public.save_repair_checklist('${vg3}', 'aberto', '{"t1":"fail"}'::jsonb)`);
r = await as("tec", `select public.finish_maintenance('${vg3}', array['t1'], array[]::text[], p_analysis => true, p_analysis_note => 'placa com curto')`);
ok("vidro e outra manutenção também pode ir para a Análise técnica", !r.err && Object.values(r.rows[0])[0] === "analise" && (await asset("VG3")).status === "analise", JSON.stringify(r));

// ---- Placa com a observação do que foi feito (migration 117)
await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('pl1', 'U-PL1', 'iPhone 12')`);
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('PL1', 'OS-PL1', '${U.tec}')`);
await as("sup", `select public.lab_deliver(array['PL1'], '${U.tec}')`);
const pl1 = await one("tec", `select public.start_legacy_maintenance('PL1')`);
r = await as("tec", `select public.declare_maintenance_items('${pl1}', '[{"nome":"Placa","qtd":1,"obs":"jumper na linha de carga"},{"nome":"Bateria","qtd":1,"obs":"  "}]'::jsonb)`);
const dec = (await db.query(`select declared_items from public.repair_stages where id = '${pl1}'`)).rows[0].declared_items;
ok("placa guarda a observação (e só quando escrita)", !r.err && dec.find((x) => x.nome === "Placa")?.obs === "jumper na linha de carga" && !("obs" in dec.find((x) => x.nome === "Bateria")), JSON.stringify([r, dec]));
const bpl = (await balloons("PL1")).at(-1);
await as("tec", `select public.lab_transfer('${bpl.id}', '${U.tec2}', 'segue com você')`);
const evPl = (await db.query(`select detail from public.lab_events where serial_key = 'pl1' and kind = 'transferencia'`)).rows[0];
ok("a observação da placa vai para o histórico da transferência", evPl?.detail?.manutencoes?.some((x) => x.obs === "jumper na linha de carga"), JSON.stringify(evPl));

// ---- Meta: o mesmo serial com a mesma OS conta um ativo; o trabalho repetido entra em manutenções (migration 118)
await db.exec(`insert into public.profiles (id, name, email, role) values ('00000000-0000-0000-0000-000000000010','Meta','m@x','tecnico')`);
U.meta = "00000000-0000-0000-0000-000000000010";
await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('rs1', 'U-RS1', 'iPhone 13')`);
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('RS1', 'OS-RS1', '${U.tec}')`);
await as("sup", `select public.lab_deliver(array['RS1'], '${U.meta}')`);
let rs = await one("meta", `select public.start_legacy_maintenance('RS1')`);
await as("meta", `select public.declare_maintenance_items('${rs}', '[{"nome":"Bateria","qtd":1}]'::jsonb)`);
await as("meta", `select public.finish_maintenance('${rs}', array[]::text[], array[]::text[], p_glass => true)`);
await as("vid", `select public.lab_direct_from_glass(array['RS1'], '${U.meta}')`);
rs = await one("meta", `select public.start_legacy_maintenance('RS1')`);
await as("meta", `select public.declare_maintenance_items('${rs}', '[{"nome":"Display","qtd":1},{"nome":"Aro","qtd":1}]'::jsonb)`);
r = await as("meta", `select public.finish_maintenance('${rs}', array[]::text[], array[]::text[], p_quarantine => true)`);
const gm = await goal("meta");
ok("mesmo serial e OS: 1 ativo na meta e nos finalizados", !r.err && gm.finalizados === 1 && gm.meta === 1 && gm.abertos === 0, JSON.stringify([r, gm]));
ok("o trabalho repetido conta em manutenções (3) e checklists (2)", gm.manutencoes === 3 && gm.checklists === 2, JSON.stringify(gm));

// ---- Aba Reprovados: direcionar os bipados para um técnico (migration 119)
for (const sn of ["RP1", "RP2"]) {
  await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('${sn.toLowerCase()}', 'U-${sn}', 'iPhone 11')`);
  await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('${sn}', 'OS-${sn}', '${U.tec}')`);
}
await as("sup", `select public.lab_deliver(array['RP2'], '${U.tec2}')`);
r = await as("tec", `select * from public.lab_direct_rejected(array['RP1'], '${U.tec}')`);
ok("técnico não direciona reprovados", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("sup", `select * from public.lab_direct_rejected(array['RP1', 'rp1', 'RP2', 'NADA'], '${U.tec}')`);
const byS = Object.fromEntries((r.rows ?? []).map((x) => [x.serial.toUpperCase(), x]));
ok("cada serial com o seu resultado", r.rows?.length === 3 && byS.RP1?.ok && byS.RP2?.reason === "com_tecnico" && byS.RP2?.holder === "Tec2" && byS.NADA?.reason === "nao_encontrado", JSON.stringify(r));
const brp = (await balloons("RP1")).at(-1);
ok("vira balão do técnico como reprovado redistribuído", brp?.technician_id === U.tec && brp.source === "redistribuicao" && brp.status === "aberto", JSON.stringify(brp));

// ---- Corrigir o técnico na Entrega (migration 120)
for (const sn of ["RA1", "RA2"]) {
  await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('${sn.toLowerCase()}', 'U-${sn}', 'iPhone 13')`);
  await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('${sn}', 'OS-${sn}', '${U.tec}')`);
}
await as("sup", `select public.lab_deliver(array['RA1', 'RA2'], '${U.tec}')`);
const ra1 = await one("tec", `select public.start_legacy_maintenance('RA1')`);
await as("tec", `select public.save_repair_checklist('${ra1}', 'aberto', '{"t1":"ok"}'::jsonb)`);
const gBeforeRa = await goal("tec");
r = await as("tec", `select * from public.lab_reassign(array['RA1'], '${U.tec2}')`);
ok("técnico não corrige o responsável", r.err?.includes("sem permissão"), JSON.stringify(r));
r = await as("sup", `select * from public.lab_reassign(array['RA1', 'RA2', 'NADA'], '${U.tec2}')`);
const byRa = Object.fromEntries((r.rows ?? []).map((x) => [x.serial.toUpperCase(), x]));
ok("supervisor troca o técnico (cada serial com o seu resultado)", byRa.RA1?.ok && byRa.RA1.previous === "Tec" && byRa.RA2?.ok && byRa.NADA?.reason === "sem_balao", JSON.stringify(r));
const bra = (await balloons("RA1")).at(-1);
ok("o balão passa para o novo técnico", bra.technician_id === U.tec2 && bra.status === "aberto", JSON.stringify(bra));
ok("o checklist em andamento vai junto", (await db.query(`select technician_id from public.repair_stages where id = '${ra1}'`)).rows[0].technician_id === U.tec2);
r = await as("tec2", `select public.start_legacy_maintenance('RA1')`);
ok("o novo técnico continua o mesmo checklist", !r.err && Object.values(r.rows[0])[0] === ra1, JSON.stringify(r));
const gAfterRa = await goal("tec");
ok("sai da meta de quem estava (sem contar como finalizado)", gAfterRa.meta === gBeforeRa.meta - 2 && gAfterRa.finalizados === gBeforeRa.finalizados, JSON.stringify([gBeforeRa, gAfterRa]));
r = await as("sup", `select * from public.lab_reassign(array['RA1'], '${U.tec2}')`);
ok("mesmo técnico: nada muda", r.rows?.[0]?.reason === "mesmo_tecnico", JSON.stringify(r));

// ---- Entregar um aparelho que já está no vidro (migration 122)
await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('gv1', 'U-GV1', 'iPhone 14')`);
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('GV1', 'OS-GV1', '${U.tec}')`);
r = await as("vid", `select public.start_glass_flow('GV1', false)`);
ok("aparelho foi para o vidro antes da entrega", !r.err && (await db.query(`select count(*)::int c from public.repair_glass_jobs where serial = 'GV1' and status <> 'concluido'`)).rows[0].c === 1, JSON.stringify(r));
r = await as("sup", `select lab_status from public.lab_preview(array['GV1'])`);
ok("prévia mostra que está no Vidro", r.rows?.[0]?.lab_status === "vidro", JSON.stringify(r));
r = await as("sup", `select public.lab_deliver(array['GV1'], '${U.tec2}')`);
const bgv = (await balloons("GV1")).at(-1);
ok("entregar = direcionar do vidro (balão Direcionado do Vidro)", !r.err && bgv?.source === "vidro" && bgv.technician_id === U.tec2, JSON.stringify([r, bgv]));
ok("o serviço de vidro é fechado (não volta sozinho depois)", (await db.query(`select count(*)::int c from public.repair_glass_jobs where serial = 'GV1' and status <> 'concluido'`)).rows[0].c === 0);
await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('gv2', 'U-GV2', 'iPhone 14')`);
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('GV2', 'OS-GV2', '${U.tec}')`);
await as("vid", `select public.start_glass_flow('GV2', false)`);
r = await as("vid", `select public.lab_direct_from_glass(array['GV2'], '${U.tec}')`);
ok("aba Vidro direciona aparelho que foi para o vidro antes da entrega", !r.err && (await balloons("GV2")).at(-1)?.technician_id === U.tec, JSON.stringify(r));

// ---- Migration 110: Checklist manutenção sem trava de balão
await db.exec(readFileSync(MIG + NO_LOCK, "utf8"));
await db.exec(readFileSync(MIG + "20261008000111_glass_send_admin.sql", "utf8"));
await as("sup", `select public.lab_deliver(array['L9'], '${U.tec2}')`).catch(() => null);
await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('nl1', 'U-NL1', 'iPhone 12')`);
await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('NL1', 'OS-NL1', '${U.tec}')`);
r = await as("tec", `select public.start_legacy_maintenance('NL1')`);
ok("sem trava: técnico abre serial sem balão", !r.err, JSON.stringify(r));
b = (await balloons("NL1")).at(-1);
ok("sem trava: o checklist vira balão de quem abriu", b?.technician_id === U.tec && b.status === "aberto", JSON.stringify(b));
await as("sup", `select public.lab_deliver(array['L1'], '${U.tec2}')`);
const nl = await one("tec", `select public.start_legacy_maintenance('L1')`);
b = (await balloons("L1")).at(-1);
ok("sem trava: balão de outro técnico passa para quem abriu", typeof nl === "string" && b.technician_id === U.tec, JSON.stringify([nl, b]));

// ---- Migration 121: checklist aberto antes do balão fecha o balão ao finalizar
// Conserto de dados: um balão preso (aberto, sem checklist ligado) com o checklist do serial já finalizado.
for (const sn of ["LK1", "LK2", "LK3"]) {
  await db.exec(`insert into public.assets (serial_key, asset_short_id, model) values ('${sn.toLowerCase()}', 'U-${sn}', 'iPhone 14')`);
  await db.exec(`insert into public.service_orders (serial, os_number, user_id) values ('${sn}', 'OS-${sn}', '${U.tec}')`);
}
const lk3 = await one("tec", `select public.start_legacy_maintenance('LK3')`);
await db.exec(`delete from public.lab_events where serial_key = 'lk3'; delete from public.lab_balloons where serial_key = 'lk3'; delete from public.lab_assets where serial_key = 'lk3';`);
await as("sup", `select public.lab_deliver(array['LK3'], '${U.tec}')`);
await db.exec(`alter table public.repair_stages disable trigger lab_on_stage`);
await db.exec(`update public.repair_stages set status = 'concluida', finished_at = now(), outcome = 'vidro' where id = '${lk3}'`);
await db.exec(`alter table public.repair_stages enable trigger lab_on_stage`);
ok("situação antiga: balão preso aberto", (await balloons("LK3")).at(-1).status === "aberto");
await db.exec(readFileSync(MIG + LINK_OPEN, "utf8"));
let blk = (await balloons("LK3")).at(-1);
ok("conserto fecha o balão preso com o destino do checklist", blk.status === "finalizado" && blk.outcome === "vidro" && blk.stage_id === lk3 && (await asset("LK3")).status === "vidro", JSON.stringify(blk));
// Checklist aberto antes da limpeza; depois o supervisor entrega e o técnico retoma e finaliza para o vidro.
const lk1 = await one("tec", `select public.start_legacy_maintenance('LK1')`);
await db.exec(`delete from public.lab_events where serial_key = 'lk1'; delete from public.lab_balloons where serial_key = 'lk1'; delete from public.lab_assets where serial_key = 'lk1';`);
await as("sup", `select public.lab_deliver(array['LK1'], '${U.tec}')`);
ok("entregue depois: balão sem checklist ligado", (await balloons("LK1")).at(-1).stage_id === null);
const lk1b = await one("tec", `select public.start_legacy_maintenance('LK1')`);
blk = (await balloons("LK1")).at(-1);
ok("retomar o checklist liga ao balão", lk1b === lk1 && blk.stage_id === lk1, JSON.stringify([lk1b, blk]));
const gLk = await goal("tec");
r = await as("tec", `select public.finish_maintenance('${lk1}', array[]::text[], array[]::text[], p_glass => true)`);
blk = (await balloons("LK1")).at(-1);
const gLk2 = await goal("tec");
ok("enviado para o vidro: balão fecha e conta na meta", !r.err && blk.status === "finalizado" && blk.outcome === "vidro" && gLk2.finalizados === gLk.finalizados + 1, JSON.stringify([r, blk, gLk, gLk2]));
// Finalizar sem passar pela retomada (checklist sem ligação): o balão do serial fecha mesmo assim.
const lk2 = await one("tec", `select public.start_legacy_maintenance('LK2')`);
await db.exec(`delete from public.lab_events where serial_key = 'lk2'; delete from public.lab_balloons where serial_key = 'lk2'; delete from public.lab_assets where serial_key = 'lk2';`);
await as("sup", `select public.lab_deliver(array['LK2'], '${U.tec}')`);
r = await as("tec", `select public.finish_maintenance('${lk2}', array[]::text[], array[]::text[], p_glass => true)`);
blk = (await balloons("LK2")).at(-1);
ok("sem ligação: ao finalizar fecha o balão aberto do serial", !r.err && blk.status === "finalizado" && blk.stage_id === null, JSON.stringify([r, blk]));

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
