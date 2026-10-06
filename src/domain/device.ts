import { ALL_ITEMS, type ChecklistItem } from "./checklist";

export type TestResult = "ok" | "fail";
export type Results = Partial<Record<string, TestResult | "">>;
export type DeviceStatus = "liberado" | "reprovado" | "incompleto";
/** Ciclo de vida do checklist: pendente pode ser alterado; concluído é definitivo. */
export type DevicePhase = "pendente" | "concluido";

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
  fase: DevicePhase;
  criado?: string;
  /** Dono do registro; vazio enquanto o rascunho ainda não foi gravado. */
  autor?: string;
  /** Nome de quem fez o checklist, para consulta por supervisor e admin. */
  colaborador?: string;
}

export type DraftField = "modelo" | "serial" | "tec";

/** Documento persistido na coleção "aparelhos". */
export interface DeviceDoc {
  modelo: string;
  serial: string;
  tec: string;
  r: Results;
  fase: DevicePhase;
  status: DeviceStatus;
  falhas: string[];
  testados: number;
  criado: string;
  atualizado: string;
}

export interface DeviceRecord extends Partial<DeviceDoc> {
  id: string;
  autor?: string;
  colaborador?: string;
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
  return { id: newDeviceId(), modelo: "", serial: "", tec, r: {}, fase: "pendente" };
}

export function draftFromRecord(record: DeviceRecord): DeviceDraft {
  return {
    id: record.id,
    modelo: record.modelo ?? "",
    serial: record.serial ?? "",
    tec: record.tec ?? "",
    r: { ...record.r },
    // Registros antigos, sem fase, seguem editáveis.
    fase: record.fase ?? "pendente",
    criado: record.criado,
    autor: record.autor,
    colaborador: record.colaborador,
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

/** O aparelho só é gravado depois de identificado: modelo, serial e técnico. */
export function isIdentified(draft: Pick<DeviceDraft, "modelo" | "serial" | "tec">): boolean {
  return [draft.modelo, draft.serial, draft.tec].every((value) => value.trim() !== "");
}

/** Editável pelo usuário logado: pendente e dele (ou ainda sem dono). */
export function isEditable(draft: DeviceDraft, userId: string): boolean {
  return draft.fase === "pendente" && (!draft.autor || draft.autor === userId);
}

export function isPending(record: DeviceRecord): boolean {
  return (record.fase ?? "pendente") === "pendente";
}

export function toDeviceDoc(draft: DeviceDraft, now: string): DeviceDoc {
  const stats = computeStats(draft.r);
  return {
    modelo: draft.modelo.trim(),
    serial: draft.serial.trim(),
    tec: draft.tec.trim(),
    r: { ...draft.r },
    fase: draft.fase,
    status: stats.status,
    falhas: stats.fails.map((item) => item.title),
    testados: stats.done,
    criado: draft.criado ?? now,
    atualizado: now,
  };
}

const normalizeSerial = (serial?: string) => (serial ?? "").trim().toLowerCase();

/**
 * Outro registro com o mesmo serial do rascunho, se houver. Prefere um
 * pendente (que pode ser retomado) a um já concluído; `records` vem do mais
 * recente para o mais antigo.
 */
export function findDuplicate(draft: DeviceDraft, records: readonly DeviceRecord[]): DeviceRecord | undefined {
  const serial = normalizeSerial(draft.serial);
  if (!serial) return undefined;
  const matches = records.filter((r) => r.id !== draft.id && normalizeSerial(r.serial) === serial);
  return matches.find(isPending) ?? matches[0];
}

export function matchesSearch(record: DeviceRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [record.serial, record.modelo, record.tec].some((v) => (v ?? "").toLowerCase().includes(q));
}
