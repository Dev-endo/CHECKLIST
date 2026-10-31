import type { ReturnCondition, ReturnReason, TestDestiny } from "../../domain/repairStages";
import type { AppSupabaseClient } from "./client";
import { call, loose, REQUEST_COLUMNS, rows, toRequest, type RequestRow, type StockRequest } from "./repairService";

/** Estoque: devoluções, destino da peça de teste, substituição e o quadro do estoquista. */

type Person = { name: string | null; email: string } | null;
const personName = (p: Person) => (p ? p.name?.trim() || p.email : "—");

// Devoluções, destino do teste e substituição (técnico) ---------------------------------------------------------

export interface StockReturn {
  id: string;
  requestId: string;
  part: string;
  reason: ReturnReason;
  qty: number;
  status: "aguardando_recebimento" | "recebida";
  requestedAt: string;
  receivedAt: string | null;
  condition: ReturnCondition | null;
}

interface ReturnRow {
  id: string;
  request_id: string;
  part: string;
  reason: ReturnReason;
  qty: number;
  status: StockReturn["status"];
  requested_at: string;
  received_at: string | null;
  condition: ReturnCondition | null;
}

const RETURN_COLUMNS = "id, request_id, part, reason, qty, status, requested_at, received_at, condition";

const toReturn = (row: ReturnRow): StockReturn => ({
  id: row.id,
  requestId: row.request_id,
  part: row.part,
  reason: row.reason,
  qty: row.qty,
  status: row.status,
  requestedAt: row.requested_at,
  receivedAt: row.received_at,
  condition: row.condition,
});

export async function fetchReturns(client: AppSupabaseClient, osId: string): Promise<StockReturn[]> {
  const found = await rows<ReturnRow>(
    loose(client).from("stock_returns").select(RETURN_COLUMNS).eq("os_id", osId).order("requested_at", { ascending: true }),
  );
  return found.map(toReturn);
}

/** Destino da peça de teste entregue: utilizar de vez ou devolver (sem justificativa). */
export const defineTestDestiny = (client: AppSupabaseClient, requestId: string, destiny: TestDestiny) =>
  call<string | null>(client, "define_test_destiny", { p_id: requestId, p_destiny: destiny });

/** Peça definitiva entregue com defeito: cria a substituta e a devolução da defeituosa. */
export const requestReplacement = (client: AppSupabaseClient, requestId: string, qty: number) =>
  call<string>(client, "request_replacement", { p_request_id: requestId, p_qty: qty });

// Quadro do estoquista ------------------------------------------------------------------------------------------

export interface BoardRequest extends StockRequest {
  osId: string;
  osNumber: string;
  serial: string;
  /** Técnico solicitante. */
  requester: string;
  model: string | null;
  unit: string | null;
}

interface BoardRow extends RequestRow {
  os_id: string;
  serial: string;
  service_orders: { os_number: string } | null;
  profiles: Person;
}

const BOARD_SELECT = `${REQUEST_COLUMNS}, os_id, serial, service_orders(os_number), profiles!requested_by(name, email)`;

/** Modelo e Unit ID pela lista de ativos, pelo serial. */
export async function assetsBySerial(client: AppSupabaseClient, serials: readonly string[]) {
  const keys = [...new Set(serials.map((serial) => serial.trim().toLowerCase()))];
  const map = new Map<string, { model: string | null; unit: string }>();
  if (!keys.length) return map;
  const found = await rows<{ serial_key: string; asset_short_id: string; model: string | null }>(
    loose(client).from("assets").select("serial_key, asset_short_id, model").in("serial_key", keys),
  );
  for (const asset of found) map.set(asset.serial_key, { model: asset.model, unit: asset.asset_short_id });
  return map;
}

/** Solicitações abertas, mais as entregues ou canceladas nos últimos `days` dias (histórico). */
export async function fetchBoard(client: AppSupabaseClient, days = 7): Promise<BoardRequest[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [open, closed] = await Promise.all([
    rows<BoardRow>(loose(client).from("stock_requests").select(BOARD_SELECT).in("status", ["pendente", "em_separacao", "sem_estoque"]).limit(500)),
    rows<BoardRow>(loose(client).from("stock_requests").select(BOARD_SELECT).in("status", ["entregue", "cancelada"]).gte("created_at", since).limit(500)),
  ]);
  const all = [...open, ...closed];
  const assets = await assetsBySerial(client, all.map((row) => row.serial));
  return all.map((row) => {
    const asset = assets.get(row.serial.trim().toLowerCase());
    return {
      ...toRequest(row),
      osId: row.os_id,
      osNumber: row.service_orders?.os_number ?? "—",
      serial: row.serial,
      requester: personName(row.profiles),
      model: asset?.model ?? null,
      unit: asset?.unit ?? null,
    };
  });
}

export interface BoardReturn extends StockReturn {
  osNumber: string;
  serial: string;
  requester: string;
  model: string | null;
}

interface BoardReturnRow extends ReturnRow {
  os_id: string;
  serial: string;
  service_orders: { os_number: string } | null;
  profiles: Person;
}

/** Devoluções aguardando o recebimento físico e as já recebidas que ficaram segregadas (fora do estoque disponível). */
export async function fetchBoardReturns(client: AppSupabaseClient): Promise<{ waiting: BoardReturn[]; segregated: BoardReturn[] }> {
  const select = `${RETURN_COLUMNS}, os_id, serial, service_orders(os_number), profiles!requested_by(name, email)`;
  const [waiting, received] = await Promise.all([
    rows<BoardReturnRow>(loose(client).from("stock_returns").select(select).eq("status", "aguardando_recebimento").order("requested_at").limit(300)),
    rows<BoardReturnRow>(
      loose(client).from("stock_returns").select(select).eq("status", "recebida").neq("condition", "funcional").order("received_at", { ascending: false }).limit(100),
    ),
  ]);
  const assets = await assetsBySerial(client, [...waiting, ...received].map((row) => row.serial));
  const toBoard = (row: BoardReturnRow): BoardReturn => ({
    ...toReturn(row),
    osNumber: row.service_orders?.os_number ?? "—",
    serial: row.serial,
    requester: personName(row.profiles),
    model: assets.get(row.serial.trim().toLowerCase())?.model ?? null,
  });
  return { waiting: waiting.map(toBoard), segregated: received.map(toBoard) };
}

export const setRequestStatus = (client: AppSupabaseClient, id: string, status: "em_separacao" | "sem_estoque") =>
  call<null>(client, "set_stock_request_status", { p_id: id, p_status: status });

/** Confirma a entrega física. Cada item vira um registro próprio; `key` identifica o clique (repetir não duplica). */
export const deliverRequests = (client: AppSupabaseClient, items: readonly { id: string; qty: number }[], key: string) =>
  call<number>(client, "deliver_stock_requests", { p_items: items, p_key: key });

export const confirmReturn = (client: AppSupabaseClient, returnId: string, condition: ReturnCondition, key: string) =>
  call<null>(client, "confirm_stock_return", { p_return_id: returnId, p_condition: condition, p_key: key });

export interface Movement {
  id: number;
  kind: string;
  qty: number;
  detail: Record<string, unknown>;
  actor: string;
  createdAt: string;
}

/** Histórico de movimentações de uma solicitação, da mais antiga para a mais nova. */
export async function fetchMovements(client: AppSupabaseClient, requestId: string): Promise<Movement[]> {
  const found = await rows<{
    id: number;
    kind: string;
    qty: number;
    detail: Record<string, unknown> | null;
    created_at: string;
    profiles: Person;
  }>(
    loose(client)
      .from("stock_movements")
      .select("id, kind, qty, detail, created_at, profiles!actor(name, email)")
      .eq("request_id", requestId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  );
  return found.map((row) => ({
    id: row.id,
    kind: row.kind,
    qty: row.qty,
    detail: row.detail ?? {},
    actor: personName(row.profiles),
    createdAt: row.created_at,
  }));
}

// Aviso ao estoquista --------------------------------------------------------------------------------------------

export interface AlertItem {
  id: string;
  kind: "solicitacao" | "devolucao";
  requester: string;
  part: string;
  qty: number;
  /** Só nas solicitações. */
  purpose: "teste" | "definitiva" | null;
  /** Só nas devoluções. */
  reason: ReturnReason | null;
  serial: string;
  osNumber: string;
}

/** O que espera o estoque: solicitações pendentes e devoluções aguardando recebimento (consulta leve, sem histórico). */
export async function fetchAlertItems(client: AppSupabaseClient): Promise<AlertItem[]> {
  const returnSelect = `${RETURN_COLUMNS}, serial, service_orders(os_number), profiles!requested_by(name, email)`;
  const [requests, waiting] = await Promise.all([
    rows<BoardRow>(loose(client).from("stock_requests").select(BOARD_SELECT).eq("status", "pendente").order("created_at").limit(50)),
    rows<BoardReturnRow>(loose(client).from("stock_returns").select(returnSelect).eq("status", "aguardando_recebimento").order("requested_at").limit(50)),
  ]);
  return [
    ...requests.map<AlertItem>((row) => ({
      id: row.id,
      kind: "solicitacao",
      requester: personName(row.profiles),
      part: row.part,
      qty: row.qty,
      purpose: row.purpose,
      reason: null,
      serial: row.serial,
      osNumber: row.service_orders?.os_number ?? "—",
    })),
    ...waiting.map<AlertItem>((row) => ({
      id: row.id,
      kind: "devolucao",
      requester: personName(row.profiles),
      part: row.part,
      qty: row.qty,
      purpose: null,
      reason: row.reason,
      serial: row.serial,
      osNumber: row.service_orders?.os_number ?? "—",
    })),
  ];
}
