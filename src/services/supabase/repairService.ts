import type { RequestPurpose, RequestStatus, Stage1Destination, TestDestiny, TimerKind, TimerTotals } from "../../domain/repairStages";
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
  outcome: "quarentena" | "analise" | "revenda" | "vidro" | null;
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
}

const STAGE_COLUMNS = "id, os_id, serial, stage, status, technician_id, round, started_at, finished_at, destination, outcome";

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
): Promise<OpenStage[]> {
  const found = await rows<StageRow & { service_orders: { os_number: string } | null }>(
    loose(client)
      .from("repair_stages")
      .select(`${STAGE_COLUMNS}, service_orders(os_number)`)
      .eq("technician_id", userId)
      .in("stage", stages)
      .in("status", statuses)
      .order("started_at", { ascending: false })
      .limit(50),
  );
  return found.map((row) => ({ ...toStage(row), osNumber: row.service_orders?.os_number ?? "—" }));
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
export const finishEvaluation = (client: AppSupabaseClient, stageId: string, destination: Stage1Destination) =>
  call<string | null>(client, "finish_evaluation", { p_stage_id: stageId, p_destination: destination });

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
  createdAt: string;
  cancelReason: string | null;
  testDestiny: TestDestiny | null;
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
  created_at: string;
  cancel_reason: string | null;
  test_destiny: TestDestiny | null;
}

export const REQUEST_COLUMNS =
  "id, part, purpose, qty, qty_delivered, status, origin_stage, replaces_request_id, created_at, cancel_reason, test_destiny";

export const toRequest = (row: RequestRow): StockRequest => ({
  id: row.id,
  part: row.part,
  purpose: row.purpose,
  qty: row.qty,
  qtyDelivered: row.qty_delivered,
  status: row.status,
  originStage: row.origin_stage,
  replacesRequestId: row.replaces_request_id,
  createdAt: row.created_at,
  cancelReason: row.cancel_reason,
  testDestiny: row.test_destiny,
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
    destination: "auto" | "vidro" | "revenda";
    resaleReason: string;
  },
) =>
  call<"quarentena" | "analise" | "revenda" | "vidro">(client, "finish_maintenance", {
    p_stage_id: input.stageId,
    p_required_open: input.requiredOpen,
    p_required_closed: input.requiredClosed,
    p_resale: input.destination === "revenda",
    p_resale_reason: input.destination === "revenda" ? input.resaleReason.trim() : null,
    p_choice: input.choice,
    p_glass: input.destination === "vidro",
  });

/** Manutenções que contam para quem finaliza a etapa (a placa que ele reparou e cada peça usada de vez). */
export const fetchMaintenanceItems = (client: AppSupabaseClient, stageId: string) =>
  call<MaintenanceItem[] | null>(client, "repair_maintenance_items", { p_stage_id: stageId }).then(
    (items) => items ?? [],
  );
