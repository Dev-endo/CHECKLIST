import type { AppSupabaseClient } from "./client";
import { call, loose, rows } from "./repairService";
import { assetsBySerial } from "./stockBoardService";

/** PT (perda total): o técnico pede, um administrador ou supervisor aprova ou reprova. */

export type PtStatus = "pendente" | "aprovado" | "reprovado";

export interface PtRequest {
  id: string;
  stageId: string;
  serial: string;
  osNumber: string;
  model: string | null;
  unit: string | null;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  status: PtStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Veio do Checklist manutenção (aparelho antigo) ou do Reparo (Estágio 2). */
  legacy: boolean;
}

type Person = { name: string | null; email: string } | null;
const personName = (p: Person) => (p ? p.name?.trim() || p.email : "—");

interface PtRow {
  id: string;
  stage_id: string;
  serial: string;
  reason: string;
  requested_at: string;
  status: PtStatus;
  decided_at: string | null;
  decision_note: string | null;
  service_orders: { os_number: string } | null;
  requester: Person;
  decider: Person;
  repair_stages: { legacy: boolean } | null;
}

const PT_SELECT =
  "id, stage_id, serial, reason, requested_at, status, decided_at, decision_note, service_orders(os_number), requester:profiles!requested_by(name, email), decider:profiles!decided_by(name, email), repair_stages(legacy)";

const toPt = (row: PtRow, asset?: { model: string | null; unit: string }): PtRequest => ({
  id: row.id,
  stageId: row.stage_id,
  serial: row.serial,
  osNumber: row.service_orders?.os_number ?? "—",
  model: asset?.model ?? null,
  unit: asset?.unit ?? null,
  reason: row.reason,
  requestedBy: personName(row.requester),
  requestedAt: row.requested_at,
  status: row.status,
  decidedBy: row.decided_at ? personName(row.decider) : null,
  decidedAt: row.decided_at,
  decisionNote: row.decision_note,
  legacy: Boolean(row.repair_stages?.legacy),
});

async function withAssets(db: AppSupabaseClient, found: PtRow[]): Promise<PtRequest[]> {
  const assets = await assetsBySerial(db, found.map((row) => row.serial)).catch(() => new Map());
  return found.map((row) => toPt(row, assets.get(row.serial.trim().toLowerCase())));
}

/** Pendentes (mais antigos primeiro) e os decididos desde `since` (mais recentes primeiro). */
export async function fetchPtRequests(db: AppSupabaseClient, since: Date): Promise<{ pending: PtRequest[]; decided: PtRequest[] }> {
  const [pending, decided] = await Promise.all([
    rows<PtRow>(loose(db).from("repair_pt_requests").select(PT_SELECT).eq("status", "pendente").order("requested_at", { ascending: true }).limit(300)),
    rows<PtRow>(
      loose(db)
        .from("repair_pt_requests")
        .select(PT_SELECT)
        .neq("status", "pendente")
        .gte("decided_at", since.toISOString())
        .order("decided_at", { ascending: false })
        .limit(300),
    ),
  ]);
  const [withPending, withDecided] = await Promise.all([withAssets(db, pending), withAssets(db, decided)]);
  return { pending: withPending, decided: withDecided };
}

/** A última reprovação de PT desta manutenção (para o técnico ver o comentário), ou null. */
export async function fetchPtRejection(db: AppSupabaseClient, stageId: string): Promise<PtRequest | null> {
  const found = await rows<PtRow>(
    loose(db).from("repair_pt_requests").select(PT_SELECT).eq("stage_id", stageId).order("requested_at", { ascending: false }).limit(1),
  );
  const last = found[0];
  return last && last.status === "reprovado" ? toPt(last) : null;
}

/** Aprova (comentário opcional) ou reprova (comentário obrigatório: a manutenção volta para o técnico). */
export const decidePt = (db: AppSupabaseClient, id: string, approve: boolean, note: string) =>
  call<null>(db, "decide_pt", { p_id: id, p_approve: approve, p_note: note.trim() || null });
