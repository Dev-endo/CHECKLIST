import type { ReplaceFailure, RequestPurpose, RequestStatus, Stage1Destination, TestDestiny, TimerKind, TimerTotals } from "../../domain/repairStages";
import type { MaintenanceItem } from "../../domain/repairChecklist";
import type { AppSupabaseClient } from "./client";

/**
 * As tabelas e funções do Reparo (migrations 44 a 48) ainda não estão em database.types.ts; até gerar os tipos
 * (`supabase gen types`), este cliente solto é usado só aqui e cada função devolve tipos próprios.
 */
export interface DbError {
  code?: string;
  message: string;
}
interface LooseClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: DbError | null }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}
export const loose = (client: AppSupabaseClient) => client as unknown as LooseClient;

export async function call<T>(client: AppSupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await loose(client).rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export async function rows<T>(query: PromiseLike<{ data: T[] | null; error: DbError | null }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/** Fases do reparo, na ordem: desmontagem e avaliação técnica (Estágio 1), manutenção (Estágio 2). */
export type RepairStageName = "desmontagem" | "avaliacao" | "manutencao";

/** aguardando_pecas: o Estágio 2 abre sozinho quando o estoque resolver todos os pedidos abertos da OS. */
export type RepairStageStatus = "em_andamento" | "concluida" | "aguardando_pecas";

export interface RepairStage {
  id: string;
  osId: string;
  serial: string;
  stage: RepairStageName;
  status: RepairStageStatus;
  technicianId: string;
  /** Rodada da OS: 1 é a primeira; reprovado na quarentena abre a 2, na mesma OS. */
  round: number;
  startedAt: string;
  finishedAt: string | null;
  /** Só na avaliação técnica concluída: para onde o aparelho foi. */
  destination: Stage1Destination | null;
  /** Só na manutenção concluída: para onde o aparelho foi. */
  outcome: "quarentena" | "analise" | "revenda" | "vidro" | "pt" | "bloqueado" | null;
  /** Vidro e outra manutenção: Vidro e Aro já pedidos; ao finalizar, o aparelho vai para o vidro. */
  needsGlass: boolean;
}

interface StageRow {
  id: string;
  os_id: string;
  serial: string;
  stage: RepairStageName;
  status: RepairStage["status"];
  technician_id: string;
  round: number;
  started_at: string;
  finished_at: string | null;
  destination: RepairStage["destination"];
  outcome: RepairStage["outcome"];
  needs_glass: boolean | null;
}

const STAGE_COLUMNS = "id, os_id, serial, stage, status, technician_id, round, started_at, finished_at, destination, outcome, needs_glass";

const toStage = (row: StageRow): RepairStage => ({
  id: row.id,
  osId: row.os_id,
  serial: row.serial,
  stage: row.stage,
  status: row.status,
  technicianId: row.technician_id,
  round: row.round,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  destination: row.destination,
  outcome: row.outcome,
  needsGlass: Boolean(row.needs_glass),
});

/** A etapa de uma OS na rodada informada (ou na mais recente), ou null se ainda não foi iniciada. */
export async function fetchStage(
  client: AppSupabaseClient,
  osId: string,
  stage: RepairStageName,
  round?: number,
): Promise<RepairStage | null> {
  let query = loose(client).from("repair_stages").select(STAGE_COLUMNS).eq("os_id", osId).eq("stage", stage);
  if (round !== undefined) query = query.eq("round", round);
  const found = await rows<StageRow>(query.order("round", { ascending: false }).limit(1));
  return found[0] ? toStage(found[0]) : null;
}

/** O aparelho foi reprovado na quarentena e pode ser desmontado de novo, com a mesma OS? */
export const canRedisassemble = (client: AppSupabaseClient, serial: string) =>
  call<boolean>(client, "redisassembly_allowed", { p_serial: serial });

export interface OpenStage extends RepairStage {
  osNumber: string;
}

/** Etapas em andamento do técnico, para retomar depois de recarregar a página. */
export async function fetchMyOpenStages(
  client: AppSupabaseClient,
  userId: string,
  stages: readonly RepairStageName[],
  statuses: readonly RepairStageStatus[] = ["em_andamento"],
  /** true: só os checklists de aparelhos antigos; false: só o fluxo do Reparo; sem valor: todos. */
  legacy?: boolean,
): Promise<OpenStage[]> {
  let query = loose(client)
    .from("repair_stages")
    .select(`${STAGE_COLUMNS}, service_orders(os_number)`)
    .eq("technician_id", userId)
    .in("stage", stages)
    .in("status", statuses);
  if (legacy !== undefined) query = query.eq("legacy", legacy);
  const found = await rows<StageRow & { service_orders: { os_number: string } | null }>(
    query.order("started_at", { ascending: false }).limit(50),
  );
  return found.map((row) => ({ ...toStage(row), osNumber: row.service_orders?.os_number ?? "—" }));
}

/** Aba Checklist manutenção: abre (ou retoma) o checklist de um aparelho antigo, na OS atual do serial. */
export const startLegacyMaintenance = (client: AppSupabaseClient, serial: string) =>
  call<string>(client, "start_legacy_maintenance", { p_serial: serial });

/** Checklist manutenção começado por outro técnico: passa para quem bipou, em branco ("Fazer um novo?" → Sim). */
export const takeLegacyChecklist = (client: AppSupabaseClient, serial: string) =>
  call<string>(client, "take_legacy_checklist", { p_serial: serial });

export interface LegacyChecklist {
  id: string;
  serial: string;
  status: RepairStageStatus;
  outcome: "quarentena" | "analise" | "vidro" | "revenda" | "pt" | "bloqueado" | null;
  startedAt: string;
  finishedAt: string | null;
  osNumber: string;
  needsGlass: boolean;
  technicianId: string;
}

interface LegacyRow {
  id: string;
  serial: string;
  status: RepairStageStatus;
  outcome: LegacyChecklist["outcome"];
  started_at: string;
  finished_at: string | null;
  service_orders: { os_number: string } | null;
  needs_glass: boolean | null;
  technician_id: string;
}

const LEGACY_COLUMNS = "id, serial, status, outcome, started_at, finished_at, needs_glass, technician_id, service_orders(os_number)";
const toLegacy = (row: LegacyRow): LegacyChecklist => ({
  id: row.id,
  serial: row.serial,
  status: row.status,
  outcome: row.outcome,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  osNumber: row.service_orders?.os_number ?? "—",
  needsGlass: Boolean(row.needs_glass),
  technicianId: row.technician_id,
});

/** O checklist mais recente do serial na aba Checklist manutenção (de qualquer técnico), ou null. */
export async function fetchLastLegacy(client: AppSupabaseClient, serial: string): Promise<LegacyChecklist | null> {
  const found = await rows<LegacyRow>(
    loose(client)
      .from("repair_stages")
      .select(LEGACY_COLUMNS)
      .eq("serial_key", serial.trim().toLowerCase())
      .eq("stage", "manutencao")
      .eq("legacy", true)
      .order("started_at", { ascending: false })
      .limit(1),
  );
  return found[0] ? toLegacy(found[0]) : null;
}

/** Checklists que o técnico finalizou na aba Checklist manutenção desde `since` (ex.: meia-noite de hoje). */
export async function fetchMyLegacyFinished(client: AppSupabaseClient, userId: string, since: Date): Promise<LegacyChecklist[]> {
  const found = await rows<LegacyRow>(
    loose(client)
      .from("repair_stages")
      .select(LEGACY_COLUMNS)
      .eq("technician_id", userId)
      .eq("stage", "manutencao")
      .eq("legacy", true)
      .eq("status", "concluida")
      .gte("finished_at", since.toISOString())
      .order("finished_at", { ascending: false })
      .limit(500),
  );
  return found.map(toLegacy);
}

export const startDisassembly = (client: AppSupabaseClient, serial: string) =>
  call<string>(client, "start_disassembly", { p_serial: serial });

/** Conclui a desmontagem e devolve o id da avaliação técnica, já aberta e com o cronômetro ligado. */
export const finishDisassembly = (client: AppSupabaseClient, stageId: string) =>
  call<string>(client, "finish_disassembly", { p_stage_id: stageId });

/**
 * Conclui a avaliação técnica e manda o aparelho para o destino escolhido. Devolve o id do Estágio 2 quando há
 * (manutenção ou aguardando peças); vidro e análise técnica encerram o Estágio 1 e devolvem null.
 */
export const finishEvaluation = (client: AppSupabaseClient, stageId: string, destination: Stage1Destination, note = "", glass = false) =>
  call<string | null>(client, "finish_evaluation", {
    p_stage_id: stageId,
    p_destination: destination,
    p_note: destination === "analise" ? note.trim() : null,
    p_glass: glass,
  });

/** Manutenção em andamento: "vidro e outra manutenção" pede Vidro e Aro agora; ao finalizar, vai para o vidro. */
export const requestGlassParts = (client: AppSupabaseClient, stageId: string) => call<null>(client, "request_glass_parts", { p_stage_id: stageId });

// Cronômetro ------------------------------------------------------------------------------------------------

export const setTimer = (client: AppSupabaseClient, stageId: string, kind: "produtivo" | "pausa" | "fim") =>
  call<null>(client, "repair_timer_set", { p_stage_id: stageId, p_kind: kind });

interface TimerRow {
  produtivo: number;
  pausa: number;
  espera_peca: number;
  open_kind: TimerKind | null;
}

/** Lê o jsonb dos totais do cronômetro que o banco devolve. */
export function toTimerTotals(data: TimerRow | null | undefined): TimerTotals {
  return {
    produtivo: Number(data?.produtivo ?? 0),
    pausa: Number(data?.pausa ?? 0),
    espera_peca: Number(data?.espera_peca ?? 0),
    openKind: data?.open_kind ?? null,
  };
}

export async function fetchTimer(client: AppSupabaseClient, stageId: string): Promise<TimerTotals> {
  return toTimerTotals(await call<TimerRow | null>(client, "repair_timer_totals", { p_stage_id: stageId }));
}

/** Como um cronômetro lê os totais e muda de sessão; a etapa e a análise técnica têm o seu cada uma. */
export interface TimerApi {
  fetch: (client: AppSupabaseClient, id: string) => Promise<TimerTotals>;
  /** "fim": para de contar (fecha a sessão aberta) sem finalizar a etapa. */
  set: (client: AppSupabaseClient, id: string, kind: "produtivo" | "pausa" | "fim") => Promise<unknown>;
}

export const stageTimerApi: TimerApi = { fetch: fetchTimer, set: setTimer };

/** Estágio 2: a etapa tem dois cronômetros, manutenção e montagem (só um corre por vez). */
const phaseTimerApi = (phase: "manutencao" | "montagem"): TimerApi => ({
  fetch: async (client, id) => toTimerTotals(await call<TimerRow | null>(client, "repair_timer_totals", { p_stage_id: id, p_phase: phase })),
  set: (client, id, kind) => call<null>(client, "repair_timer_set", { p_stage_id: id, p_kind: kind, p_phase: phase }),
});

export const maintenanceTimerApi = phaseTimerApi("manutencao");
export const assemblyTimerApi = phaseTimerApi("montagem");

// Solicitações de peça ----------------------------------------------------------------------------------------

export interface StockRequest {
  id: string;
  part: string;
  purpose: RequestPurpose;
  qty: number;
  qtyDelivered: number;
  status: RequestStatus;
  /** "analise": pedida pelo analista durante a Análise técnica. */
  originStage: RepairStageName | "analise" | null;
  replacesRequestId: string | null;
  /** Substituição: tipo de falha e por que o técnico substituiu a peça. */
  replaceFailure: ReplaceFailure | null;
  replaceReason: string | null;
  createdAt: string;
  cancelReason: string | null;
  testDestiny: TestDestiny | null;
  /** Peça do vidro (Vidro e Aro): do técnico de vidro; não trava a manutenção nem conta para quem finaliza. */
  glass: boolean;
}

export interface RequestRow {
  id: string;
  part: string;
  purpose: RequestPurpose;
  qty: number;
  qty_delivered: number;
  status: RequestStatus;
  origin_stage: StockRequest["originStage"];
  replaces_request_id: string | null;
  replace_failure: ReplaceFailure | null;
  replace_reason: string | null;
  created_at: string;
  cancel_reason: string | null;
  test_destiny: TestDestiny | null;
  glass: boolean | null;
}

export const REQUEST_COLUMNS =
  "id, part, purpose, qty, qty_delivered, status, origin_stage, replaces_request_id, replace_failure, replace_reason, created_at, cancel_reason, test_destiny, glass";

export const toRequest = (row: RequestRow): StockRequest => ({
  id: row.id,
  part: row.part,
  purpose: row.purpose,
  qty: row.qty,
  qtyDelivered: row.qty_delivered,
  status: row.status,
  originStage: row.origin_stage,
  replacesRequestId: row.replaces_request_id,
  replaceFailure: row.replace_failure,
  replaceReason: row.replace_reason,
  createdAt: row.created_at,
  cancelReason: row.cancel_reason,
  testDestiny: row.test_destiny,
  glass: Boolean(row.glass),
});

/** Todas as solicitações da OS (as de todas as fases), da mais antiga para a mais nova. */
export async function fetchRequests(client: AppSupabaseClient, osId: string): Promise<StockRequest[]> {
  const found = await rows<RequestRow>(
    loose(client).from("stock_requests").select(REQUEST_COLUMNS).eq("os_id", osId).order("created_at", { ascending: true }),
  );
  return found.map(toRequest);
}

export const createRequest = (client: AppSupabaseClient, input: { serial: string; part: string; purpose: RequestPurpose; qty: number }) =>
  call<string>(client, "create_stock_request", { p_serial: input.serial, p_part: input.part, p_purpose: input.purpose, p_qty: input.qty });

export const cancelRequest = (client: AppSupabaseClient, id: string, reason: string) =>
  call<null>(client, "cancel_stock_request", { p_id: id, p_reason: reason });

// Estágio 2: checklists e finalização ----------------------------------------------------------------------------

/** Resultados gravados de cada fase (aberto/fechado), como vieram do banco. */
export async function fetchChecklists(client: AppSupabaseClient, stageId: string): Promise<Partial<Record<"aberto" | "fechado", unknown>>> {
  const found = await rows<{ phase: "aberto" | "fechado"; results: unknown }>(
    loose(client).from("repair_checklist_results").select("phase, results").eq("stage_id", stageId),
  );
  return Object.fromEntries(found.map((row) => [row.phase, row.results]));
}

export const saveChecklist = (client: AppSupabaseClient, stageId: string, phase: "aberto" | "fechado", results: Record<string, unknown>) =>
  call<null>(client, "save_repair_checklist", { p_stage_id: stageId, p_phase: phase, p_results: results });

/** Finaliza a manutenção; o banco confere tudo de novo e devolve o destino (quarentena, analise ou revenda). */
export const finishMaintenance = (
  client: AppSupabaseClient,
  input: {
    stageId: string;
    requiredOpen: string[];
    requiredClosed: string[];
    choice: string[];
    destination: "auto" | "vidro" | "revenda" | "analise" | "pt" | "bloqueado";
    resaleReason: string;
    /** Motivo do envio para a Análise técnica (obrigatório quando o aparelho vai para lá). */
    analysisNote?: string;
  },
) =>
  call<"quarentena" | "analise" | "revenda" | "vidro" | "pt" | "bloqueado">(client, "finish_maintenance", {
    p_stage_id: input.stageId,
    p_required_open: input.requiredOpen,
    p_required_closed: input.requiredClosed,
    p_resale: input.destination === "revenda",
    p_resale_reason: ["revenda", "pt", "bloqueado"].includes(input.destination) ? input.resaleReason.trim() : null,
    p_choice: input.choice,
    p_glass: input.destination === "vidro",
    p_analysis: input.destination === "analise",
    p_analysis_note: input.analysisNote?.trim() || null,
    p_pt: input.destination === "pt",
    p_blocked: input.destination === "bloqueado",
  });

/** Manutenções que contam para quem finaliza a etapa (a placa que ele reparou e cada peça usada de vez). */
export const fetchMaintenanceItems = (client: AppSupabaseClient, stageId: string) =>
  call<MaintenanceItem[] | null>(client, "repair_maintenance_items", { p_stage_id: stageId }).then(
    (items) => items ?? [],
  );

// Vidro direto: o técnico de vidro recebe o aparelho, faz o vidro e segue para o checklist (migration 90) ---------

/**
 * Começa o fluxo do vidro. Com desmontagem devolve o id da desmontagem (que já pede Vidro e Aro); sem desmontagem
 * devolve o id do serviço de vidro, já aberto.
 */
export const startGlassFlow = (client: AppSupabaseClient, serial: string, disassemble: boolean) =>
  call<string>(client, "start_glass_flow", { p_serial: serial, p_disassemble: disassemble });

/** Conclui a desmontagem do fluxo do vidro e abre o serviço de vidro (sem avaliação técnica). */
export const finishGlassFlowDisassembly = (client: AppSupabaseClient, stageId: string) =>
  call<string>(client, "finish_glass_flow_disassembly", { p_stage_id: stageId });

export interface MaintenanceTechnician {
  id: string;
  name: string;
}

/** Técnicos de manutenção que podem receber um aparelho direcionado pelo destino Manutenção. */
export const listMaintenanceTechnicians = (client: AppSupabaseClient) =>
  call<MaintenanceTechnician[] | null>(client, "list_maintenance_technicians").then((found) => found ?? []);

/** Destino Manutenção: passa a etapa em andamento para o técnico escolhido, com o motivo. */
export const handOverMaintenance = (client: AppSupabaseClient, stageId: string, technicianId: string, note: string) =>
  call<null>(client, "hand_over_maintenance", { p_stage_id: stageId, p_technician: technicianId, p_note: note.trim() });

export interface Handover {
  from: string;
  note: string;
  at: string;
}

/**
 * Quem direcionou esta manutenção para o técnico (e o motivo), ou null. Sem a migration 90 a coluna não existe:
 * a tela segue sem o aviso.
 */
export async function fetchHandover(client: AppSupabaseClient, stageId: string): Promise<Handover | null> {
  try {
    const found = await rows<{ handover_note: string | null; handover_at: string | null; profiles: { name: string | null; email: string } | null }>(
      loose(client).from("repair_stages").select("handover_note, handover_at, profiles!handover_from(name, email)").eq("id", stageId).limit(1),
    );
    const row = found[0];
    if (!row?.handover_note || !row.handover_at) return null;
    return { from: row.profiles ? row.profiles.name?.trim() || row.profiles.email : "—", note: row.handover_note, at: row.handover_at };
  } catch {
    return null;
  }
}

/** Nome de uma pessoa (técnico de manutenção, por exemplo); null se não achar. */
export async function fetchPersonName(client: AppSupabaseClient, id: string): Promise<string | null> {
  try {
    const found = await rows<{ name: string | null; email: string }>(loose(client).from("profiles").select("name, email").eq("id", id).limit(1));
    const row = found[0];
    return row ? row.name?.trim() || row.email : null;
  } catch {
    return null;
  }
}

// Limpeza: manutenção que não pede peça e conta como 1 (migration 92) ---------------------------------------------------

/** Liga ou desliga a limpeza da manutenção. Não liga se já há pedido de peça na etapa. */
export const setMaintenanceCleaning = (client: AppSupabaseClient, stageId: string, cleaning: boolean) =>
  call<null>(client, "set_maintenance_cleaning", { p_stage_id: stageId, p_cleaning: cleaning });

/** Se a etapa está marcada como limpeza. Sem a migration 92 a coluna não existe: segue como não. */
export async function fetchCleaning(client: AppSupabaseClient, stageId: string): Promise<boolean> {
  try {
    const found = await rows<{ cleaning: boolean | null }>(loose(client).from("repair_stages").select("cleaning").eq("id", stageId).limit(1));
    return Boolean(found[0]?.cleaning);
  } catch {
    return false;
  }
}

// Aba Reprovados: quem teve a mão em cada aparelho (migration 94) -------------------------------------------------------

export interface ReprovadoRow {
  serial: string;
  osNumber: string | null;
  outcome: string | null;
  finishedAt: string | null;
  responsavel: string | null;
  desmontagem: string | null;
  checklist: string | null;
  manutencao: string | null;
  placa: string | null;
  montagem: string | null;
  quarentena: string | null;
  quarentenaPor: string | null;
  quarentenaEm: string | null;
  /** Manutenções contadas (texto) e o total. */
  feitas: string | null;
  feitasQtd: number | null;
}

interface ReprovadoDb {
  serial: string;
  os_number: string | null;
  outcome: string | null;
  finished_at: string | null;
  responsavel: string | null;
  desmontagem: string | null;
  checklist: string | null;
  manutencao: string | null;
  placa: string | null;
  montagem: string | null;
  quarentena: string | null;
  quarentena_por: string | null;
  quarentena_em: string | null;
  feitas: string | null;
  feitas_qtd: number | null;
}

/** Por serial: o técnico responsável e quem fez a desmontagem, o checklist, a manutenção e a montagem (OS mais recente). */
export async function fetchReprovados(client: AppSupabaseClient, serials: readonly string[]): Promise<ReprovadoRow[]> {
  const found = await call<ReprovadoDb[] | null>(client, "reprovados_lookup", { p_serials: [...serials] });
  return (found ?? []).map((row) => ({
    serial: row.serial,
    osNumber: row.os_number,
    outcome: row.outcome,
    finishedAt: row.finished_at,
    responsavel: row.responsavel,
    desmontagem: row.desmontagem,
    checklist: row.checklist,
    manutencao: row.manutencao,
    placa: row.placa,
    montagem: row.montagem,
    quarentena: row.quarentena,
    quarentenaPor: row.quarentena_por,
    quarentenaEm: row.quarentena_em,
    feitas: row.feitas,
    feitasQtd: row.feitas_qtd,
  }));
}

/** Manutenções que o técnico informa ao finalizar o checklist (migration 95): trocam a lista da etapa; vazia = nenhuma. */
export const declareMaintenanceItems = (client: AppSupabaseClient, stageId: string, items: readonly { nome: string; qtd: number }[]) =>
  call<null>(client, "declare_maintenance_items", { p_stage_id: stageId, p_items: [...items] });
