import type { SwappedPart } from "../../domain/stock";
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

/** Peças trocadas no período pela decisão do estoquista: erro técnico ou peça ruim (qualidade do fornecedor). */
export async function fetchSwappedParts(client: AppSupabaseClient, filters: MaintenanceReportFilters): Promise<SwappedPart[]> {
  const { from, to } = range(filters);
  const { data, error } = await client.rpc("swapped_parts", { p_from: from, p_to: to, p_user: filters.userId || undefined });
  if (error) throw error;
  return data.map((row) => ({
    reason: row.reason === "erro_tecnico" ? "erro_tecnico" : "peca_ruim",
    part: row.part,
    model: row.model,
    person: row.technician,
    userId: row.user_id,
    at: row.swapped_at,
  }));
}
