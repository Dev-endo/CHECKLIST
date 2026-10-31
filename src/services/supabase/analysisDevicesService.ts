import type { ChecklistKind } from "../../domain/checklist";
import { describeMaintenance, parseMaintenances } from "../../domain/maintenance";
import type { AppSupabaseClient } from "./client";
import type { MaintenanceReportFilters } from "./reportService";

/** Um aparelho (checklist concluído) que compõe um número da Análise. */
export interface AnalysisDevice {
  /** Etapa: manutenção, montagem, desmontagem, desmontagem técnica ou quarentena. */
  stage: ChecklistKind | "quarentena";
  serial: string;
  /** asset_short_id (ex.: "iPhone 14 128GB-2386"), do checklist ou da planilha de ativos. */
  unit: string | null;
  destination: string | null;
  status: string;
  person: string;
  at: string | null;
  /** Observações reunidas: texto escrito, manutenções, peças, falhas e notas da desmontagem técnica. */
  observations: string[];
  /** Quantas vezes o ativo já foi reprovado na montagem (todo o histórico do serial). */
  assemblyRejections: number;
}

const startOfDay = (date: string) => new Date(`${date}T00:00:00`);

export async function fetchAnalysisDevices(
  client: AppSupabaseClient,
  metric: string,
  filters: MaintenanceReportFilters,
): Promise<AnalysisDevice[]> {
  let to: string | undefined;
  if (filters.to) {
    const nextDay = startOfDay(filters.to);
    nextDay.setDate(nextDay.getDate() + 1);
    to = nextDay.toISOString();
  }
  const { data, error } = await client.rpc("analysis_devices", {
    p_metric: metric,
    p_from: filters.from ? startOfDay(filters.from).toISOString() : undefined,
    p_to: to,
    p_user: filters.userId || undefined,
  });
  if (error) throw error;
  return data.map((row) => {
    const observations: string[] = [];
    if (row.notes) observations.push(row.notes);
    const maintenances = parseMaintenances(row.maintenances);
    if (maintenances.length) observations.push(`Manutenções: ${maintenances.map(describeMaintenance).join(" · ")}`);
    const parts = parseMaintenances(row.parts);
    if (parts.length) observations.push(`Peças: ${parts.map(describeMaintenance).join(" · ")}`);
    if (row.failures?.length) observations.push(`Falhas: ${row.failures.join(" · ")}`);
    if (row.consumption_note) observations.push(`Consumo: ${row.consumption_note}`);
    if (row.pt_note) observations.push(`PT: ${row.pt_note}`);
    return {
      stage: row.kind as AnalysisDevice["stage"],
      serial: row.serial,
      unit: row.unit,
      destination: row.destination,
      status: row.status,
      person: row.technician,
      at: row.concluded_at,
      observations,
      assemblyRejections: Number(row.assembly_rejections ?? 0),
    };
  });
}
