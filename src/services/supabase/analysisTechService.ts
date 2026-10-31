import { parseFailedTests, type FailedTestEntry } from "../../domain/repairChecklist";
import type { RequestPurpose } from "../../domain/repairStages";
import type { AppSupabaseClient } from "./client";
import { call, loose, REQUEST_COLUMNS, rows, toRequest, toTimerTotals, type RequestRow, type StockRequest, type TimerApi } from "./repairService";
import type { StockReturn } from "./stockBoardService";
import { assetsBySerial } from "./stockBoardService";

/** Aba Análise técnica: fila de aparelhos, começar e finalizar a análise. */

export type AnalysisResult = "troca_periferico" | "reparo_placa";

export interface AnalysisItem {
  id: string;
  serial: string;
  osNumber: string;
  model: string | null;
  unit: string | null;
  /** estagio1: veio do fim do Estágio 1. manutencao: a manutenção terminou com teste reprovado. */
  source: "estagio1" | "manutencao";
  status: "aguardando" | "em_analise";
  failedTests: FailedTestEntry[];
  /** Técnico responsável: o aparelho volta para ele no Estágio 2. */
  technician: string;
  /** Quem mandou o aparelho para a análise técnica (a quem devolver). */
  sentBy: string;
  sentAt: string | null;
  /** Quem começou a análise (só ele finaliza; o admin também). */
  startedBy: string | null;
  startedById: string | null;
  createdAt: string;
  startedAt: string | null;
}

interface Person {
  name: string | null;
  email: string;
}

interface QueueRow {
  id: string;
  serial: string;
  source: AnalysisItem["source"];
  status: AnalysisItem["status"];
  failed_tests: unknown;
  created_at: string;
  started_at: string | null;
  started_by: string | null;
  sent_at: string | null;
  service_orders: { os_number: string } | null;
  repair_stages: { profiles: Person | null } | null;
  profiles: Person | null;
  sender: Person | null;
}

const personName = (p: Person | null | undefined) => (p ? p.name?.trim() || p.email : "—");

export async function fetchAnalysisQueue(client: AppSupabaseClient): Promise<AnalysisItem[]> {
  const found = await rows<QueueRow>(
    loose(client)
      .from("repair_analysis_queue")
      .select(
        "id, serial, source, status, failed_tests, created_at, started_at, started_by, sent_at, service_orders(os_number), repair_stages(profiles!technician_id(name, email)), profiles!started_by(name, email), sender:profiles!sent_by(name, email)",
      )
      .in("status", ["aguardando", "em_analise"])
      .order("created_at", { ascending: true })
      .limit(300),
  );
  const assets = await assetsBySerial(client, found.map((row) => row.serial));
  return found.map((row) => {
    const asset = assets.get(row.serial.trim().toLowerCase());
    return {
      id: row.id,
      serial: row.serial,
      osNumber: row.service_orders?.os_number ?? "—",
      model: asset?.model ?? null,
      unit: asset?.unit ?? null,
      source: row.source,
      status: row.status,
      failedTests: parseFailedTests(row.failed_tests),
      technician: personName(row.repair_stages?.profiles),
      sentBy: personName(row.sender ?? row.repair_stages?.profiles),
      sentAt: row.sent_at,
      startedBy: row.started_by ? personName(row.profiles) : null,
      startedById: row.started_by,
      createdAt: row.created_at,
      startedAt: row.started_at,
    };
  });
}

export const startAnalysis = (client: AppSupabaseClient, id: string) => call<null>(client, "start_analysis", { p_id: id });

export interface AnalysisPart {
  part: string;
  purpose: RequestPurpose;
  qty: number;
}

/**
 * Finaliza a análise. Troca de periférico cria os pedidos de peça; com `self`, o próprio analista faz a troca
 * (checklist e montagem na Análise técnica), senão o aparelho volta ao Estágio 2 de quem mandou.
 */
export const finishAnalysis = (
  client: AppSupabaseClient,
  id: string,
  result: AnalysisResult,
  parts: readonly AnalysisPart[] = [],
  self = false,
) =>
  call<string | null>(client, "finish_analysis", {
    p_id: id,
    p_result: result,
    p_parts: result === "troca_periferico" ? parts : [],
    p_self: result === "troca_periferico" && self,
  });

/** Cronômetro da análise: começa sozinho ao começar a análise; dá para pausar e retomar. */
export const analysisTimerApi: TimerApi = {
  fetch: async (client, id) => toTimerTotals(await call(client, "analysis_timer_totals", { p_id: id })),
  set: (client, id, kind) => call<null>(client, "analysis_timer_set", { p_id: id, p_kind: kind }),
};

// Reparo em placa (segundo estágio da aba Análise técnica) ---------------------------------------------------------

export type BoardDestination = "quarentena" | "vidro" | "estagio2";

export interface BoardItem {
  id: string;
  serial: string;
  osNumber: string;
  model: string | null;
  unit: string | null;
  status: "aguardando" | "em_andamento";
  /** Técnico responsável: o aparelho volta para ele se o destino for o Estágio 2 ou o vidro. */
  technician: string;
  /** Quem mandou o aparelho para a análise técnica (a quem devolver). */
  sentBy: string;
  sentAt: string | null;
  /** Analista que fez a análise: só ele (ou o admin) inicia o reparo. */
  analyst: string;
  analystId: string | null;
  /** Quem iniciou o reparo (só ele finaliza; o admin também). */
  startedById: string | null;
  startedAt: string | null;
  /** Início da análise: as peças de teste (da análise e do reparo) contam a partir daqui. */
  analysisStartedAt: string | null;
  analysisFinishedAt: string | null;
}

interface BoardRow {
  id: string;
  serial: string;
  board_status: BoardItem["status"];
  board_by: string | null;
  board_started_at: string | null;
  started_at: string | null;
  finished_by: string | null;
  finished_at: string | null;
  sent_at: string | null;
  service_orders: { os_number: string } | null;
  repair_stages: { profiles: Person | null } | null;
  profiles: Person | null;
  sender: Person | null;
}

export async function fetchBoardRepairs(client: AppSupabaseClient): Promise<BoardItem[]> {
  const found = await rows<BoardRow>(
    loose(client)
      .from("repair_analysis_queue")
      .select(
        "id, serial, board_status, board_by, board_started_at, started_at, finished_by, finished_at, sent_at, service_orders(os_number), repair_stages(profiles!technician_id(name, email)), profiles!finished_by(name, email), sender:profiles!sent_by(name, email)",
      )
      .in("board_status", ["aguardando", "em_andamento"])
      .order("finished_at", { ascending: true })
      .limit(300),
  );
  const assets = await assetsBySerial(client, found.map((row) => row.serial));
  return found.map((row) => {
    const asset = assets.get(row.serial.trim().toLowerCase());
    return {
      id: row.id,
      serial: row.serial,
      osNumber: row.service_orders?.os_number ?? "—",
      model: asset?.model ?? null,
      unit: asset?.unit ?? null,
      status: row.board_status,
      technician: personName(row.repair_stages?.profiles),
      sentBy: personName(row.sender ?? row.repair_stages?.profiles),
      sentAt: row.sent_at,
      analyst: personName(row.profiles),
      analystId: row.finished_by,
      startedById: row.board_by,
      startedAt: row.board_started_at,
      analysisStartedAt: row.started_at,
      analysisFinishedAt: row.finished_at,
    };
  });
}

/** Inicia o reparo em placa (liga o cronômetro). Só quem fez a análise, ou o admin. */
export const startBoardRepair = (client: AppSupabaseClient, id: string) => call<null>(client, "start_board_repair", { p_id: id });

/** Finaliza com a observação do serviço feito. O destino vem junto: quarentena, vidro ou Estágio 2 (devolve o id dele). */
export const finishBoardRepair = (client: AppSupabaseClient, id: string, note: string, destination: BoardDestination) =>
  call<string | null>(client, "finish_board_repair", { p_id: id, p_note: note.trim(), p_destination: destination });

/** Cronômetro do reparo em placa: mesmo botão de pausar e retomar, com o tempo próprio do reparo. */
export const boardTimerApi: TimerApi = {
  fetch: async (client, id) => toTimerTotals(await call(client, "analysis_timer_totals", { p_id: id, p_phase: "reparo_placa" })),
  set: (client, id, kind) => call<null>(client, "analysis_timer_set", { p_id: id, p_kind: kind }),
};

// Peças de teste da análise ------------------------------------------------------------------------------------------

/** Peças de teste pedidas nesta análise (desde que ela começou) e as devoluções delas. */
export async function fetchAnalysisParts(
  client: AppSupabaseClient,
  analysisId: string,
  startedAt: string,
): Promise<{ requests: StockRequest[]; returns: StockReturn[] }> {
  const found = await rows<RequestRow>(
    loose(client)
      .from("stock_requests")
      .select(REQUEST_COLUMNS)
      .eq("analysis_id", analysisId)
      .gte("created_at", startedAt)
      .order("created_at", { ascending: true }),
  );
  const requests = found.map(toRequest);
  if (!requests.length) return { requests, returns: [] };
  const back = await rows<{
    id: string;
    request_id: string;
    part: string;
    reason: StockReturn["reason"];
    qty: number;
    status: StockReturn["status"];
    requested_at: string;
    received_at: string | null;
    condition: StockReturn["condition"];
  }>(
    loose(client)
      .from("stock_returns")
      .select("id, request_id, part, reason, qty, status, requested_at, received_at, condition")
      .in("request_id", requests.map((r) => r.id)),
  );
  return {
    requests,
    returns: back.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      part: row.part,
      reason: row.reason,
      qty: row.qty,
      status: row.status,
      requestedAt: row.requested_at,
      receivedAt: row.received_at,
      condition: row.condition,
    })),
  };
}

/** O analista pede uma peça para teste (pausa o cronômetro da análise: espera de peça). */
export const requestAnalysisTestPart = (client: AppSupabaseClient, analysisId: string, part: string) =>
  call<string>(client, "analysis_request_test_part", { p_id: analysisId, p_part: part });
