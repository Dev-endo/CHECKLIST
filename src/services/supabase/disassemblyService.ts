import type { AppSupabaseClient } from "./client";
import type { MaintenanceReportFilters } from "./reportService";

/** Desmontagem normal + técnica no período; cada checklist concluído conta. */
export interface DisassemblyReport {
  total: number;
  toAssembly: number;
  toMaintenance: number;
  toAnalysis: number;
  toPt: number;
}

const startOfDay = (date: string) => new Date(`${date}T00:00:00`);

export async function fetchDisassemblyReport(
  client: AppSupabaseClient,
  filters: MaintenanceReportFilters,
): Promise<DisassemblyReport> {
  let to: string | undefined;
  if (filters.to) {
    const nextDay = startOfDay(filters.to);
    nextDay.setDate(nextDay.getDate() + 1);
    to = nextDay.toISOString();
  }
  const { data, error } = await client.rpc("disassembly_report", {
    p_from: filters.from ? startOfDay(filters.from).toISOString() : undefined,
    p_to: to,
    p_user: filters.userId || undefined,
  });
  if (error) throw error;
  const raw = data as unknown as {
    total: number;
    to_assembly: number;
    to_maintenance: number;
    to_analysis: number;
    to_pt: number;
  };
  return {
    total: raw.total ?? 0,
    toAssembly: raw.to_assembly ?? 0,
    toMaintenance: raw.to_maintenance ?? 0,
    toAnalysis: raw.to_analysis ?? 0,
    toPt: raw.to_pt ?? 0,
  };
}
