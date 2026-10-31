import {
  parseAllocationStatus,
  parseRequestKind,
  type AllocationAction,
  type AllocationStatus,
  type RequestKind,
  type SwapDecision,
} from "../../domain/stock";
import type { AppSupabaseClient } from "./client";

/** Uma peça alocada a um aparelho, dentro de uma OS. */
export interface PartAllocation {
  id: string;
  osId: string;
  part: string;
  status: AllocationStatus;
  createdAt: string;
  allocatedBy: string;
}

interface AllocationRow {
  id: string;
  os_id: string;
  part: string;
  status: string;
  created_at: string;
  profiles: { name: string; email: string } | null;
}

/** Peças alocadas ao aparelho (pelo serial), da mais recente para a mais antiga. */
export async function fetchSerialAllocations(client: AppSupabaseClient, serial: string): Promise<PartAllocation[]> {
  const { data, error } = await client
    .from("part_allocations")
    // A ligação com profiles é explícita: quem alocou (user_id).
    .select("id, os_id, part, status, created_at, profiles!part_allocations_user_id_fkey(name, email)")
    .eq("serial_key", serial.trim().toLowerCase())
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as unknown as AllocationRow[]).map((row) => ({
    id: row.id,
    osId: row.os_id,
    part: row.part,
    status: parseAllocationStatus(row.status),
    createdAt: row.created_at,
    allocatedBy: row.profiles ? row.profiles.name || row.profiles.email : "—",
  }));
}

/** "no_os": o aparelho ainda não tem OS (o desmontador registra). "duplicate": peça já alocada na OS. */
export type AllocateResult = "ok" | "no_os" | "duplicate";

/** Aloca a peça no aparelho, na OS atual dele. */
export async function allocatePart(
  client: AppSupabaseClient,
  allocation: { serial: string; part: string },
): Promise<AllocateResult> {
  const { error } = await client.rpc("allocate_part", {
    p_serial: allocation.serial.trim(),
    p_part: allocation.part,
  });
  if (!error) return "ok";
  if (error.code === "23505") return "duplicate";
  if (error.message.includes("no_os")) return "no_os";
  throw error;
}

/** Um pedido de peça ao estoque. */
export interface PartRequest {
  id: string;
  osId: string;
  part: string;
  kind: RequestKind;
  allocationId: string | null;
  loanId: string | null;
  createdAt: string;
}

/** Pedidos pendentes do aparelho (da OS mais recente), para o técnico saber o que está esperando o estoque. */
export async function fetchPendingRequests(client: AppSupabaseClient, serial: string): Promise<PartRequest[]> {
  const { data, error } = await client
    .from("part_requests")
    .select("id, os_id, part, kind, allocation_id, loan_id, created_at")
    .eq("serial_key", serial.trim().toLowerCase())
    .eq("status", "pendente")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data.map((row) => ({
    id: row.id,
    osId: row.os_id,
    part: row.part,
    kind: parseRequestKind(row.kind),
    allocationId: row.allocation_id,
    loanId: row.loan_id,
    createdAt: row.created_at,
  }));
}

/** "no_os": o aparelho não tem OS do estoque. "duplicate": já existe pedido igual pendente. */
export type RequestResult = "ok" | "no_os" | "duplicate";

export async function requestPart(
  client: AppSupabaseClient,
  request: { serial: string; part: string; kind: RequestKind; allocationId?: string; loanId?: string },
): Promise<RequestResult> {
  const { error } = await client.rpc("request_part", {
    p_serial: request.serial.trim(),
    p_part: request.part,
    p_kind: request.kind,
    p_allocation_id: request.allocationId,
    p_loan_id: request.loanId,
  });
  if (!error) return "ok";
  if (error.code === "23505") return "duplicate";
  if (error.message.includes("no_os")) return "no_os";
  throw error;
}

/** Fecha as peças alocadas ao concluir o checklist: concluir (aplicada) ou devolver (não precisou). */
export async function closeAllocations(
  client: AppSupabaseClient,
  actions: readonly { id: string; action: AllocationAction }[],
): Promise<void> {
  for (const { id, action } of actions) {
    const { error } = await client.rpc("complete_allocation", { p_id: id, p_action: action });
    if (error) throw error;
  }
}

/** Pedido pendente como o estoquista vê no aviso. */
export interface PendingRequest {
  id: string;
  kind: RequestKind;
  part: string;
  osNumber: string;
  model: string | null;
  requester: string;
  createdAt: string;
}

export async function fetchAllPendingRequests(client: AppSupabaseClient): Promise<PendingRequest[]> {
  const { data, error } = await client.rpc("pending_part_requests");
  if (error) throw error;
  return data.map((row) => ({
    id: row.id,
    kind: parseRequestKind(row.kind),
    part: row.part,
    osNumber: row.os_number,
    model: row.model,
    requester: row.requester,
    createdAt: row.created_at,
  }));
}

/** O estoquista decide: recusar, atender (peça nova) ou, na troca, peca_ruim / erro_tecnico. */
export async function resolvePartRequest(
  client: AppSupabaseClient,
  id: string,
  decision: "recusar" | "atender" | SwapDecision,
): Promise<"ok" | "duplicate"> {
  const { error } = await client.rpc("resolve_part_request", { p_id: id, p_decision: decision });
  if (!error) return "ok";
  if (error.code === "23505") return "duplicate";
  throw error;
}

/** Uma peça de teste emprestada (ou já devolvida / liberada para uso). */
export interface PartLoan {
  id: string;
  osId: string;
  part: string;
  status: "emprestada" | "devolvida" | "em_uso";
}

/** Peças de teste do aparelho (pelo serial). */
export async function fetchSerialLoans(client: AppSupabaseClient, serial: string): Promise<PartLoan[]> {
  const { data, error } = await client
    .from("part_loans")
    .select("id, os_id, part, status")
    .eq("serial_key", serial.trim().toLowerCase())
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data.map((row) => ({
    id: row.id,
    osId: row.os_id,
    part: row.part,
    status: row.status === "devolvida" || row.status === "em_uso" ? row.status : "emprestada",
  }));
}

/** Peça emprestada como o estoquista vê na janela de empréstimos. */
export interface OpenLoan {
  id: string;
  part: string;
  model: string | null;
  osNumber: string;
  borrower: string;
  since: string;
}

export async function fetchOpenLoans(client: AppSupabaseClient): Promise<OpenLoan[]> {
  const { data, error } = await client.rpc("open_part_loans");
  if (error) throw error;
  return data.map((row) => ({
    id: row.id,
    part: row.part,
    model: row.model,
    osNumber: row.os_number,
    borrower: row.borrower,
    since: row.since,
  }));
}

/** O estoquista registra que a peça de teste voltou ao estoque. */
export async function returnLoan(client: AppSupabaseClient, loanId: string): Promise<void> {
  const { error } = await client.rpc("return_loan", { p_loan_id: loanId });
  if (error) throw error;
}

/** Quem pode receber uma peça de teste: técnicos e desmontadores. */
export interface Borrower {
  id: string;
  name: string;
}

export async function fetchBorrowers(client: AppSupabaseClient): Promise<Borrower[]> {
  const { data, error } = await client.rpc("stock_borrowers");
  if (error) throw error;
  return data;
}

/** Mesmos resultados da alocação; "duplicate": a peça já está emprestada nessa OS. */
export async function lendTestPart(
  client: AppSupabaseClient,
  loan: { serial: string; part: string; borrower: string },
): Promise<AllocateResult> {
  const { error } = await client.rpc("lend_test_part", {
    p_serial: loan.serial.trim(),
    p_part: loan.part,
    p_borrower: loan.borrower,
  });
  if (!error) return "ok";
  if (error.code === "23505") return "duplicate";
  if (error.message.includes("no_os")) return "no_os";
  throw error;
}

/** Aparelho que a desmontagem enviou para alocação de peça e o estoque ainda não tocou. */
export interface AwaitingDevice {
  id: string;
  kind: string;
  model: string | null;
  sender: string;
  since: string;
}

export async function fetchAwaitingAllocation(client: AppSupabaseClient): Promise<AwaitingDevice[]> {
  const { data, error } = await client.rpc("awaiting_allocation");
  if (error) throw error;
  return data;
}

/** Peça alocada a um aparelho (visão geral do estoquista). */
export interface OpenAllocation {
  id: string;
  part: string;
  osNumber: string;
  model: string | null;
  status: AllocationStatus;
  createdAt: string;
  allocatedBy: string;
}

interface OpenAllocationRow {
  id: string;
  part: string;
  status: string;
  serial_key: string | null;
  created_at: string;
  service_orders: { os_number: string } | null;
  profiles: { name: string; email: string } | null;
}

const ALLOCATION_SELECT =
  "id, part, status, serial_key, created_at, service_orders(os_number), profiles!part_allocations_user_id_fkey(name, email)";

/** Completa o modelo pela planilha de ativos, pelo serial. */
async function withModels(client: AppSupabaseClient, rows: OpenAllocationRow[]): Promise<OpenAllocation[]> {
  const keys = [...new Set(rows.flatMap((row) => (row.serial_key ? [row.serial_key] : [])))];
  const models = new Map<string, string | null>();
  if (keys.length) {
    const { data, error } = await client.from("assets").select("serial_key, model").in("serial_key", keys);
    if (error) throw error;
    for (const asset of data) if (asset.serial_key) models.set(asset.serial_key, asset.model);
  }
  return rows.map((row) => ({
    id: row.id,
    part: row.part,
    osNumber: row.service_orders?.os_number ?? "—",
    model: row.serial_key ? (models.get(row.serial_key) ?? null) : null,
    status: parseAllocationStatus(row.status),
    createdAt: row.created_at,
    allocatedBy: row.profiles ? row.profiles.name || row.profiles.email : "—",
  }));
}

/** Todas as peças alocadas (liberadas no aparelho) e ainda não concluídas, devolvidas ou trocadas. */
export async function fetchOpenAllocations(client: AppSupabaseClient): Promise<OpenAllocation[]> {
  const { data, error } = await client
    .from("part_allocations")
    .select(ALLOCATION_SELECT)
    .eq("status", "liberada")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return withModels(client, data as unknown as OpenAllocationRow[]);
}

const startOfDay = (date: string) => new Date(`${date}T00:00:00`);

/** Peças alocadas no período (datas "AAAA-MM-DD", inclusive), com o status de cada uma. */
export async function fetchAllocationsInPeriod(client: AppSupabaseClient, from: string, to: string): Promise<OpenAllocation[]> {
  let query = client.from("part_allocations").select(ALLOCATION_SELECT).order("created_at", { ascending: false }).limit(500);
  if (from) query = query.gte("created_at", startOfDay(from).toISOString());
  if (to) {
    const nextDay = startOfDay(to);
    nextDay.setDate(nextDay.getDate() + 1);
    query = query.lt("created_at", nextDay.toISOString());
  }
  const { data, error } = await query;
  if (error) throw error;
  return withModels(client, data as unknown as OpenAllocationRow[]);
}
