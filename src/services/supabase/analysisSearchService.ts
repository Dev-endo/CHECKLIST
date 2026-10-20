import type { ChecklistKind } from "../../domain/checklist";
import type { AppSupabaseClient } from "./client";
import type { MaintenanceReportFilters } from "./reportService";

const startOfDay = (date: string) => new Date(`${date}T00:00:00`);

/** Intervalo [from, to) em ISO, a partir das datas dos filtros (o dia final entra inteiro). */
function range(filters: MaintenanceReportFilters): { from?: string; to?: string } {
  let to: string | undefined;
  if (filters.to) {
    const nextDay = startOfDay(filters.to);
    nextDay.setDate(nextDay.getDate() + 1);
    to = nextDay.toISOString();
  }
  return { from: filters.from ? startOfDay(filters.from).toISOString() : undefined, to };
}

/** Uma peça trocada em um aparelho, e quem fez a troca. */
export interface PartChange {
  stage: ChecklistKind;
  serial: string;
  unit: string | null;
  model: string | null;
  destination: string | null;
  userId: string;
  person: string;
  at: string | null;
  item: string;
  detail: string | null;
}

/** Peças trocadas no período; `item` vazio traz todas. */
export async function fetchPartChanges(
  client: AppSupabaseClient,
  item: string,
  filters: MaintenanceReportFilters,
): Promise<PartChange[]> {
  const { from, to } = range(filters);
  const { data, error } = await client.rpc("analysis_parts", {
    p_item: item || undefined,
    p_from: from,
    p_to: to,
    p_user: filters.userId || undefined,
  });
  if (error) throw error;
  return data.map((row) => ({
    stage: row.kind as ChecklistKind,
    serial: row.serial,
    unit: row.unit,
    model: row.model,
    destination: row.destination,
    userId: row.user_id,
    person: row.technician,
    at: row.concluded_at,
    item: row.item,
    detail: row.detail,
  }));
}

/** O que um colaborador concluiu no período, por etapa. */
export interface CollaboratorSummary {
  userId: string;
  name: string;
  /** Checklists de manutenção concluídos. */
  maintenance: number;
  /** Manutenções feitas (itens), contando também as trocas da desmontagem técnica. */
  maintenanceItems: number;
  disassembly: number;
  technical: number;
  assembly: number;
  quarantine: number;
}

export async function fetchCollaboratorSummary(
  client: AppSupabaseClient,
  filters: MaintenanceReportFilters,
): Promise<CollaboratorSummary[]> {
  const { from, to } = range(filters);
  const { data, error } = await client.rpc("collaborator_summary", { p_from: from, p_to: to });
  if (error) throw error;
  return data.map((row) => ({
    userId: row.user_id,
    name: row.name,
    maintenance: Number(row.maintenance),
    maintenanceItems: Number(row.maintenance_items),
    disassembly: Number(row.disassembly),
    technical: Number(row.technical),
    assembly: Number(row.assembly),
    quarantine: Number(row.quarantine),
  }));
}
