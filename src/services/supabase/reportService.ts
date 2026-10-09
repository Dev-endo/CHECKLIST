import type { AppSupabaseClient } from "./client";

export interface MaintenanceReportFilters {
  /** Datas no formato YYYY-MM-DD (campo de data do navegador), ou vazio. */
  from: string;
  to: string;
  /** Id do colaborador, ou vazio para todos. */
  userId: string;
}

export interface MaintenanceReport {
  /** Checklists concluídos no período. */
  checklists: number;
  /** Seriais (ativos) liberados: cada serial conta uma vez. */
  assetsReleased: number;
  /** Ativos cujo último checklist do período não liberou. */
  assetsNotReleased: number;
  assetsWithMaintenance: number;
  /** Ativos (seriais) liberados para montagem e para vidro no período. */
  releasedAssembly: number;
  releasedGlass: number;
  byTechnician: { name: string; assembly: number; glass: number; rejected: number }[];
  /** Total de manutenções registradas (uma por item marcado). */
  maintenancesTotal: number;
  byItem: { item: string; count: number; assets: number }[];
  placaDetails: { detail: string; count: number }[];
}

const startOfDay = (date: string) => new Date(`${date}T00:00:00`);

export async function fetchMaintenanceReport(
  client: AppSupabaseClient,
  filters: MaintenanceReportFilters,
): Promise<MaintenanceReport> {
  let to: string | undefined;
  if (filters.to) {
    const nextDay = startOfDay(filters.to);
    nextDay.setDate(nextDay.getDate() + 1);
    to = nextDay.toISOString();
  }
  const { data, error } = await client.rpc("maintenance_report", {
    p_from: filters.from ? startOfDay(filters.from).toISOString() : undefined,
    p_to: to,
    p_user: filters.userId || undefined,
  });
  if (error) throw error;
  const raw = data as unknown as {
    checklists: number;
    assets_released: number;
    assets_not_released: number;
    assets_with_maintenance: number;
    released_assembly: number;
    released_glass: number;
    by_technician: { name: string; assembly: number; glass: number; rejected: number }[];
    maintenances_total: number;
    by_item: { item: string; count: number; assets: number }[];
    placa_details: { detail: string; count: number }[];
  };
  return {
    checklists: raw.checklists,
    assetsReleased: raw.assets_released,
    assetsNotReleased: raw.assets_not_released ?? 0,
    assetsWithMaintenance: raw.assets_with_maintenance,
    releasedAssembly: raw.released_assembly ?? 0,
    releasedGlass: raw.released_glass ?? 0,
    byTechnician: raw.by_technician ?? [],
    maintenancesTotal: raw.maintenances_total,
    byItem: raw.by_item,
    placaDetails: raw.placa_details,
  };
}
