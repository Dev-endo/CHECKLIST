import { catalogFor } from "./catalogs";
import { ALL_SECTIONS, type ChecklistItem as CatalogItem, type ChecklistKind } from "./checklist";
import type { Blame, Destination, Maintenance } from "./maintenance";

/** Tópico do checklist (a unidade que recebe OK ou Falha). */
export type ChecklistItem = (typeof ALL_SECTIONS)[number];

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
  /** Qual checklist: manutenção ou montagem. */
  tipo: ChecklistKind;
  /** asset_short_id do ativo, preenchido ao bipar um serial da planilha de ativos. */
  ativo?: string;
  /** Saúde da bateria em %; só guarda BATTERY_TARGET (caixa marcada) ou fica vazio. */
  bateria?: number;
  /** Manutenções informadas ao concluir um checklist liberado. */
  manutencoes?: Maintenance[];
  /** Destino escolhido ao concluir um checklist liberado. */
  destino?: Destination;
  /** Montagem reprovada: de quem foi o erro e em quais peças. */
  culpa?: Blame;
  pecas?: Maintenance[];
  /** Checklist de manutenção que liberou o aparelho para esta montagem. */
  origem?: string;
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
  ativo?: string;
  bateria?: number;
  manutencoes?: Maintenance[];
  destino?: Destination;
  tipo?: ChecklistKind;
  culpa?: Blame;
  pecas?: Maintenance[];
  origem?: string;
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

/** Total de tópicos a marcar. */
export const TOTAL_TESTS = ALL_SECTIONS.length;

/** Total de tópicos do checklist do tipo informado. */
/** Tópicos que recebem OK ou Falha (os que só têm caixa de confirmação não entram). */
const testedSections = (kind: ChecklistKind) => catalogFor(kind).filter((block) => !block.confirmOnly);

export const totalTests = (kind: ChecklistKind = "manutencao"): number => testedSections(kind).length;

/** "iPhone 14 128GB-2386" vira modelo "iPhone 14 128GB" e unit id "2386" (separa no último hífen). */
export function splitAssetId(assetShortId: string): { model: string; code: string } {
  const cut = assetShortId.lastIndexOf("-");
  if (cut < 0) return { model: assetShortId, code: "" };
  return { model: assetShortId.slice(0, cut), code: assetShortId.slice(cut + 1) };
}

export function newDeviceId(): string {
  return crypto.randomUUID();
}

export function blankDraft(tec = "", kind: ChecklistKind = "manutencao"): DeviceDraft {
  return { id: newDeviceId(), modelo: "", serial: "", tec, r: {}, fase: "pendente", tipo: kind };
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
    ativo: record.ativo,
    bateria: record.bateria,
    manutencoes: record.manutencoes,
    tipo: record.tipo ?? "manutencao",
    destino: record.destino,
    culpa: record.culpa,
    pecas: record.pecas,
    origem: record.origem,
    criado: record.criado,
    autor: record.autor,
    colaborador: record.colaborador,
  };
}

export function computeStats(results: Results = {}, kind: ChecklistKind = "manutencao"): DeviceStats {
  const sections = testedSections(kind);
  const fails = sections.filter((item) => results[item.id] === "fail");
  const pending = sections.filter((item) => !results[item.id]);
  const done = sections.length - pending.length;
  const status: DeviceStatus = fails.length ? "reprovado" : pending.length ? "incompleto" : "liberado";
  return { done, fails, pending, status };
}

/** Marca ou desmarca o resultado de um tópico; sair de "Falha" limpa os itens apontados. */
export function toggleSectionResult(
  results: Results,
  sectionId: string,
  result: TestResult,
  kind: ChecklistKind = "manutencao",
): Results {
  const next: TestResult | "" = results[sectionId] === result ? "" : result;
  const updated: Results = { ...results, [sectionId]: next };
  if (next !== "fail") {
    for (const item of catalogFor(kind).find((block) => block.id === sectionId)?.items ?? []) delete updated[item.id];
  }
  return updated;
}

/** Aponta (ou tira) o item em que a falha ocorreu; só vale com o tópico em "Falha". */
export function toggleItemFailure(results: Results, sectionId: string, itemId: string): Results {
  if (results[sectionId] !== "fail") return results;
  const updated: Results = { ...results };
  if (updated[itemId] === "fail") delete updated[itemId];
  else updated[itemId] = "fail";
  return updated;
}

/** Texto das falhas: "Tópico: item" para cada item apontado, ou só o tópico se nenhum foi apontado. */
export function describeFailures(results: Results = {}, kind: ChecklistKind = "manutencao"): string[] {
  return catalogFor(kind).filter((block) => results[block.id] === "fail").flatMap((block) => {
    const items = block.items.filter((item) => results[item.id] === "fail");
    return items.length ? items.map((item) => `${block.title}: ${item.title}`) : [block.title];
  });
}

/** Chave, dentro de results, da confirmação obrigatória de um item (não confunde com a falha do item). */
export const confirmKey = (itemId: string) => `confirm:${itemId}`;

export function isConfirmed(results: Results, itemId: string): boolean {
  return results[confirmKey(itemId)] === "ok";
}

export function setConfirmation(results: Results, itemId: string, checked: boolean): Results {
  const updated: Results = { ...results };
  if (checked) updated[confirmKey(itemId)] = "ok";
  else delete updated[confirmKey(itemId)];
  return updated;
}

/** Confirmações obrigatórias que ainda não foram marcadas; enquanto houver, não dá para concluir. */
export function missingConfirmations(results: Results = {}, kind: ChecklistKind = "manutencao"): CatalogItem[] {
  return catalogFor(kind).flatMap((block) => block.items).filter(
    (item) => item.field === "confirm" && !isConfirmed(results, item.id),
  );
}

/** Saúde da bateria exigida: a caixa do item marca que o ativo está com esse valor. */
export const BATTERY_TARGET = 85;

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
  const stats = computeStats(draft.r, draft.tipo);
  return {
    modelo: draft.modelo.trim(),
    serial: draft.serial.trim(),
    tec: draft.tec.trim(),
    r: { ...draft.r },
    fase: draft.fase,
    ativo: draft.ativo,
    bateria: draft.bateria,
    manutencoes: draft.manutencoes ?? [],
    destino: draft.destino,
    tipo: draft.tipo,
    culpa: draft.culpa,
    pecas: draft.pecas ?? [],
    origem: draft.origem,
    status: stats.status,
    falhas: describeFailures(draft.r, draft.tipo),
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

/** Data local no formato do campo de data do navegador (YYYY-MM-DD). */
export function toDateInputValue(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Mesmo dia no horário local de quem usa o app. */
export function isSameLocalDay(iso: string | undefined, now = new Date()): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  return (
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  );
}

/**
 * Dos checklists de UM serial, o que libera o aparelho: o último concluído, se estiver liberado.
 * Se quem fechou por último reprovou, nenhum libera.
 */
export function latestReleasingId(history: readonly DeviceRecord[]): string | undefined {
  const concluded = history.filter((r) => r.fase === "concluido" && r.tipo !== "montagem");
  const last = concluded.reduce<DeviceRecord | undefined>(
    (best, r) => (!best || (r.atualizado ?? "") >= (best.atualizado ?? "") ? r : best),
    undefined,
  );
  return last?.status === "liberado" ? last.id : undefined;
}

export function matchesSearch(record: DeviceRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [record.serial, record.modelo, record.tec].some((v) => (v ?? "").toLowerCase().includes(q));
}
