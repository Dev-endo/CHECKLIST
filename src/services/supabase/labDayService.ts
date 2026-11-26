import {
  serialKey,
  type BalloonOutcome,
  type BalloonRow,
  type BalloonSource,
  type BalloonStatus,
  type BoardAsset,
  type LabGoal,
  type LabStatus,
  type SerialCheck,
} from "../../domain/labDay";
import type { AppSupabaseClient } from "./client";
import { call } from "./repairService";

/** Dia Laboratório (migration 108): tudo passa por funções do banco, que conferem o papel de quem chama. */

export interface LabTechnician {
  id: string;
  name: string;
}

export const listLabTechnicians = (client: AppSupabaseClient) => call<LabTechnician[] | null>(client, "lab_technicians").then((found) => found ?? []);

/** Unit ID, onde o ativo está e com quem, para cada serial (chave: serial em minúsculas). */
export async function previewSerials(client: AppSupabaseClient, serials: readonly string[]): Promise<Map<string, SerialCheck>> {
  const unique = [...new Map(serials.map((serial) => [serialKey(serial), serial.trim()])).values()];
  const map = new Map<string, SerialCheck>();
  if (!unique.length) return map;
  const found = await call<
    { serial: string; found: boolean; unit: string | null; model: string | null; lab_status: LabStatus | null; holder: string | null }[] | null
  >(client, "lab_preview", { p_serials: unique });
  for (const row of found ?? []) {
    map.set(serialKey(row.serial), {
      serial: row.serial,
      found: row.found,
      unit: row.unit,
      model: row.model,
      labStatus: row.lab_status,
      holder: row.holder,
    });
  }
  return map;
}

/** Vincula os seriais ao técnico. Devolve quantos foram vinculados. */
export const deliverAssets = (client: AppSupabaseClient, serials: readonly string[], technicianId: string) =>
  call<number>(client, "lab_deliver", { p_serials: serials, p_technician: technicianId });

/** Direciona ativos do Vidro para o técnico (supervisor, admin ou técnico de vidro). */
export const directFromGlass = (client: AppSupabaseClient, serials: readonly string[], technicianId: string, display = false) =>
  call<number>(client, "lab_direct_from_glass", { p_serials: serials, p_technician: technicianId, p_display: display });

/** Seriais com status Vidro (em minúsculas). */
export const fetchGlassSerials = (client: AppSupabaseClient) =>
  call<{ serial: string }[] | null>(client, "lab_glass_serials").then((found) => new Set((found ?? []).map((row) => serialKey(row.serial))));

export interface RejectedAsset {
  assetId: string;
  serial: string;
  unit: string | null;
  model: string | null;
  lastTechnician: string | null;
  rejectedAt: string | null;
}

export async function fetchRejected(client: AppSupabaseClient): Promise<RejectedAsset[]> {
  const found = await call<
    { asset_id: string; serial: string; unit: string | null; model: string | null; last_technician: string | null; rejected_at: string | null }[] | null
  >(client, "lab_rejected");
  return (found ?? []).map((row) => ({
    assetId: row.asset_id,
    serial: row.serial,
    unit: row.unit,
    model: row.model,
    lastTechnician: row.last_technician,
    rejectedAt: row.rejected_at,
  }));
}

export const redistributeRejected = (client: AppSupabaseClient, assetIds: readonly string[], technicianId: string) =>
  call<number>(client, "lab_redistribute", { p_assets: assetIds, p_technician: technicianId });

/** Aba Reprovados: direciona os seriais para o técnico (cada um vira balão); devolve o resultado de cada serial. */
export interface DirectRejectedResult {
  serial: string;
  ok: boolean;
  reason: "nao_encontrado" | "com_tecnico" | null;
  holder: string | null;
}

export const directRejected = (client: AppSupabaseClient, serials: readonly string[], technicianId: string) =>
  call<DirectRejectedResult[] | null>(client, "lab_direct_rejected", { p_serials: serials, p_technician: technicianId }).then((found) => found ?? []);

/** Entrega: corrige o técnico dos ativos já vinculados (o balão passa para o escolhido). */
export interface ReassignResult {
  serial: string;
  ok: boolean;
  reason: "sem_balao" | "mesmo_tecnico" | null;
  previous: string | null;
}

export const reassignAssets = (client: AppSupabaseClient, serials: readonly string[], technicianId: string) =>
  call<ReassignResult[] | null>(client, "lab_reassign", { p_serials: serials, p_technician: technicianId }).then((found) => found ?? []);

/** Acompanhamento: retira o ativo do técnico sem transferir (o balão some; entrega por engano sai de "Entraram"). */
export interface RemoveResult {
  serial: string;
  ok: boolean;
  reason: "sem_balao" | "checklist_aberto" | null;
  previous: string | null;
}

export const removeAssets = (client: AppSupabaseClient, serials: readonly string[]) =>
  call<RemoveResult[] | null>(client, "lab_remove", { p_serials: serials }).then((found) => found ?? []);

// Técnico ------------------------------------------------------------------------------------------------------------

export interface MyBalloon {
  id: string;
  serial: string;
  unit: string | null;
  model: string | null;
  /** pendente: transferência aguardando a confirmação. */
  status: "pendente" | "aberto";
  source: BalloonSource;
  fromName: string | null;
  note: string | null;
  createdAt: string;
  stageId: string | null;
}

export async function fetchMyBalloons(client: AppSupabaseClient): Promise<MyBalloon[]> {
  const found = await call<
    {
      id: string;
      serial: string;
      unit: string | null;
      model: string | null;
      status: "pendente" | "aberto";
      source: BalloonSource;
      from_name: string | null;
      note: string | null;
      created_at: string;
      stage_id: string | null;
    }[] | null
  >(client, "lab_my_balloons");
  return (found ?? []).map((row) => ({
    id: row.id,
    serial: row.serial,
    unit: row.unit,
    model: row.model,
    status: row.status,
    source: row.source,
    fromName: row.from_name,
    note: row.note,
    createdAt: row.created_at,
    stageId: row.stage_id,
  }));
}

export const transferBalloon = (client: AppSupabaseClient, balloonId: string, technicianId: string, note: string) =>
  call<string>(client, "lab_transfer", { p_balloon: balloonId, p_technician: technicianId, p_note: note.trim() || null });

export const confirmTransfer = (client: AppSupabaseClient, balloonId: string) => call<null>(client, "lab_confirm_transfer", { p_balloon: balloonId });

export async function fetchMyLabGoal(client: AppSupabaseClient): Promise<LabGoal | null> {
  const data = await call<Record<string, number | string | null> | null>(client, "lab_my_goal");
  if (!data) return null;
  return {
    finished: Number(data.finalizados ?? 0),
    transferred: Number(data.transferidos ?? 0),
    open: Number(data.abertos ?? 0),
    pending: Number(data.pendentes ?? 0),
    goal: Number(data.meta ?? 0),
    maintenances: Number(data.manutencoes ?? 0),
    checklists: Number(data.checklists ?? data.finalizados ?? 0),
    justification: (data.justificativa as string | null) ?? null,
  };
}

/** Análise > Produtividade: a meta dos balões de cada técnico no dia (por id). */
export interface LabProductivity {
  finished: number;
  transferred: number;
  open: number;
  goal: number;
}

export async function fetchLabProductivity(client: AppSupabaseClient, day: string): Promise<Map<string, LabProductivity>> {
  const found = await call<{ user_id: string; finalizados: number; transferidos: number; abertos: number; meta: number }[] | null>(
    client,
    "lab_productivity",
    { p_day: day },
  );
  return new Map(
    (found ?? []).map((row) => [
      row.user_id,
      { finished: Number(row.finalizados), transferred: Number(row.transferidos), open: Number(row.abertos), goal: Number(row.meta) },
    ]),
  );
}

// Acompanhamento -----------------------------------------------------------------------------------------------------

export async function fetchBoard(client: AppSupabaseClient, from: Date, to: Date): Promise<BoardAsset[]> {
  const found = await call<
    {
      id: string;
      serial: string;
      unit: string | null;
      status: LabStatus;
      technician: string | null;
      last_technician: string | null;
      entered_at: string;
      exited_at: string | null;
      rejected_at: string | null;
      last_move_at: string;
      os_number?: string | null;
    }[] | null
  >(client, "lab_board", { p_from: from.toISOString(), p_to: to.toISOString() });
  return (found ?? []).map((row) => ({
    id: row.id,
    serial: row.serial,
    unit: row.unit,
    status: row.status,
    technician: row.technician,
    lastTechnician: row.last_technician,
    enteredAt: row.entered_at,
    exitedAt: row.exited_at,
    rejectedAt: row.rejected_at,
    lastMoveAt: row.last_move_at,
    osNumber: row.os_number ?? null,
  }));
}

export async function fetchBalloonReport(client: AppSupabaseClient, from: Date, to: Date): Promise<BalloonRow[]> {
  const found = await call<
    {
      id: string;
      serial: string;
      unit: string | null;
      technician_id: string;
      technician: string | null;
      status: BalloonStatus;
      source: BalloonSource;
      from_name: string | null;
      transferred_to: string | null;
      outcome: BalloonOutcome | null;
      created_at: string;
      confirmed_at: string | null;
      finished_at: string | null;
      os_number?: string | null;
    }[] | null
  >(client, "lab_balloon_report", { p_from: from.toISOString(), p_to: to.toISOString() });
  return (found ?? []).map((row) => ({
    id: row.id,
    serial: row.serial,
    unit: row.unit,
    technicianId: row.technician_id,
    technician: row.technician ?? "—",
    status: row.status,
    source: row.source,
    fromName: row.from_name,
    transferredTo: row.transferred_to,
    outcome: row.outcome,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    finishedAt: row.finished_at,
    osNumber: row.os_number ?? null,
  }));
}

export interface LabHistoryEntry {
  kind: string;
  actor: string | null;
  fromName: string | null;
  toName: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export async function fetchLabHistory(client: AppSupabaseClient, serial: string): Promise<LabHistoryEntry[]> {
  const found = await call<
    { kind: string; actor: string | null; from_name: string | null; to_name: string | null; detail: Record<string, unknown>; created_at: string }[] | null
  >(client, "lab_history", { p_serial: serial });
  return (found ?? []).map((row) => ({
    kind: row.kind,
    actor: row.actor,
    fromName: row.from_name,
    toName: row.to_name,
    detail: row.detail ?? {},
    createdAt: row.created_at,
  }));
}
