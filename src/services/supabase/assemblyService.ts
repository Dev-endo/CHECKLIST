import type { AppSupabaseClient } from "./client";

export interface AssemblySource {
  /** Checklist de manutenção que liberou (ou não) o aparelho. */
  deviceId: string;
  destination: string | null;
  status: "liberado" | "reprovado" | "incompleto";
  technician: string;
}

/** Último checklist de manutenção concluído do serial, ou null se nunca passou pela manutenção. */
export async function fetchAssemblySource(client: AppSupabaseClient, serial: string): Promise<AssemblySource | null> {
  const { data, error } = await client.rpc("assembly_source", { p_serial: serial });
  if (error) throw error;
  const row = data[0];
  return row
    ? { deviceId: row.device_id, destination: row.destination, status: row.status, technician: row.technician }
    : null;
}

/** O aparelho pode ser montado? Só se o último checklist de manutenção o liberou para montagem. */
export function describeAssemblyBlock(source: AssemblySource | null): string | null {
  if (!source) return "Este aparelho não passou pelo checklist de manutenção.";
  if (source.destination === "analise") return "Este aparelho foi enviado para análise técnica.";
  if (source.status !== "liberado") return "O último checklist de manutenção deste aparelho não o liberou.";
  if (source.destination !== "montagem") return "Este aparelho foi enviado para vidro e ainda está em manutenção.";
  return null;
}

/** Uma montagem reprovada: o aparelho, quem fez a manutenção, quem montou e o motivo. */
export interface AssemblyRejection {
  /** asset_short_id do aparelho (ex.: "iPhone 14 128GB-2386"), se estiver na planilha de ativos. */
  unit: string | null;
  serial: string;
  /** Técnico do checklist de manutenção que liberou o aparelho para a montagem. */
  technician: string | null;
  assembler: string;
  /** Tópicos reprovados e peças marcadas. */
  reasons: string[];
  parts: string[];
  /** Para onde seguiu (analise ou manutencao) e a observação escrita. */
  destination?: string | null;
  note?: string | null;
}

export interface AssemblyReport {
  /** Montagens feitas: cada checklist de montagem concluído conta, mesmo do mesmo serial. */
  checklists: number;
  /** Aprovados (cada serial uma vez) e reprovados (cada reprovação) na montagem no período. */
  released: number;
  /** Aprovados que seguiram para bloqueio e para laudo (cada serial uma vez). */
  releasedBlock: number;
  releasedReport: number;
  /** Reprovados na montagem que voltaram para a manutenção (cada serial uma vez). */
  returnedMaintenance: number;
  rejected: number;
  byAssembler: { name: string; released: number; rejected: number }[];
  byPart: { part: string; count: number }[];
  rejections: AssemblyRejection[];
}

export interface AssemblyReportFilters {
  from: string;
  to: string;
  /** Id do montador, ou vazio para todos. */
  userId: string;
}

const startOfDay = (date: string) => new Date(`${date}T00:00:00`);

export async function fetchAssemblyReport(
  client: AppSupabaseClient,
  filters: AssemblyReportFilters,
): Promise<AssemblyReport> {
  let to: string | undefined;
  if (filters.to) {
    const nextDay = startOfDay(filters.to);
    nextDay.setDate(nextDay.getDate() + 1);
    to = nextDay.toISOString();
  }
  const { data, error } = await client.rpc("assembly_report", {
    p_from: filters.from ? startOfDay(filters.from).toISOString() : undefined,
    p_to: to,
    p_user: filters.userId || undefined,
  });
  if (error) throw error;
  const raw = data as unknown as {
    checklists: number;
    released: number;
    released_block?: number;
    released_report?: number;
    returned_maintenance?: number;
    rejected: number;
    by_assembler: { name: string; released: number; rejected: number }[];
    by_part: { part: string; count: number }[];
    rejections?: AssemblyRejection[];
  };
  return {
    checklists: raw.checklists,
    released: raw.released,
    releasedBlock: raw.released_block ?? 0,
    releasedReport: raw.released_report ?? 0,
    returnedMaintenance: raw.returned_maintenance ?? 0,
    rejected: raw.rejected,
    byAssembler: raw.by_assembler,
    byPart: raw.by_part,
    rejections: raw.rejections ?? [],
  };
}
