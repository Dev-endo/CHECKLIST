import { ALL_ITEMS, type ChecklistItem } from "./checklist";

export type TestResult = "ok" | "fail";
export type Results = Partial<Record<string, TestResult | "">>;
export type DeviceStatus = "liberado" | "reprovado" | "incompleto";

/**
 * Aparelho em edição. Os nomes dos campos seguem o esquema já gravado no
 * banco ("modelo", "serial", "tec", "r"), para manter os registros antigos.
 */
export interface DeviceDraft {
  id: string;
  modelo: string;
  serial: string;
  tec: string;
  r: Results;
  criado?: string;
}

export type DraftField = "modelo" | "serial" | "tec";

/** Documento persistido na coleção "aparelhos". */
export interface DeviceDoc {
  modelo: string;
  serial: string;
  tec: string;
  r: Results;
  status: DeviceStatus;
  falhas: string[];
  testados: number;
  criado: string;
  atualizado: string;
}

export interface DeviceRecord extends Partial<DeviceDoc> {
  id: string;
}

export interface DeviceStats {
  done: number;
  fails: ChecklistItem[];
  pending: ChecklistItem[];
  status: DeviceStatus;
}

export const TOTAL_TESTS = ALL_ITEMS.length;

export function newDeviceId(): string {
  return crypto.randomUUID();
}

export function blankDraft(tec = ""): DeviceDraft {
  return { id: newDeviceId(), modelo: "", serial: "", tec, r: {} };
}

export function draftFromRecord(record: DeviceRecord): DeviceDraft {
  return {
    id: record.id,
    modelo: record.modelo ?? "",
    serial: record.serial ?? "",
    tec: record.tec ?? "",
    r: { ...record.r },
    criado: record.criado,
  };
}

export function computeStats(results: Results = {}): DeviceStats {
  const fails = ALL_ITEMS.filter((item) => results[item.id] === "fail");
  const pending = ALL_ITEMS.filter((item) => !results[item.id]);
  const done = TOTAL_TESTS - pending.length;
  const status: DeviceStatus = fails.length ? "reprovado" : pending.length ? "incompleto" : "liberado";
  return { done, fails, pending, status };
}

export function hasContent(draft: DeviceDraft): boolean {
  return Boolean(draft.serial || draft.modelo || Object.values(draft.r).some(Boolean));
}

export function toDeviceDoc(draft: DeviceDraft, now: string): DeviceDoc {
  const stats = computeStats(draft.r);
  return {
    modelo: draft.modelo,
    serial: draft.serial,
    tec: draft.tec,
    r: { ...draft.r },
    status: stats.status,
    falhas: stats.fails.map((item) => item.title),
    testados: stats.done,
    criado: draft.criado ?? now,
    atualizado: now,
  };
}

const normalizeSerial = (serial?: string) => (serial ?? "").trim().toLowerCase();

/** Outro registro com o mesmo serial do rascunho, se houver. */
export function findDuplicate(draft: DeviceDraft, records: readonly DeviceRecord[]): DeviceRecord | undefined {
  const serial = normalizeSerial(draft.serial);
  if (!serial) return undefined;
  return records.find((r) => r.id !== draft.id && normalizeSerial(r.serial) === serial);
}

export function matchesSearch(record: DeviceRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [record.serial, record.modelo, record.tec].some((v) => (v ?? "").toLowerCase().includes(q));
}
