import type { AppSupabaseClient } from "./client";
import { toMaintenanceTotals, type MaintenanceTotals } from "./dashboardService";
import { call } from "./repairService";

/** Meta diária do técnico: aparelhos liberados hoje para a quarentena e para o vidro. */
export interface DailyGoal {
  liberados: number;
  quarentena: number;
  vidro: number;
  meta: number;
  /** Justificativa de hoje (abaixo da meta), se já escrita. */
  justificativa: string | null;
  /** Manutenções de hoje (aparelhos que o técnico finalizou) e o caminho das peças. */
  manutencao: MaintenanceTotals | null;
}

export async function fetchMyGoal(client: AppSupabaseClient): Promise<DailyGoal> {
  const data = await call<(Omit<Partial<DailyGoal>, "manutencao"> & { manutencao?: Record<string, number> }) | null>(client, "repair_my_goal", {});
  return {
    liberados: Number(data?.liberados ?? 0),
    quarentena: Number(data?.quarentena ?? 0),
    vidro: Number(data?.vidro ?? 0),
    meta: Number(data?.meta ?? 6),
    justificativa: data?.justificativa ?? null,
    manutencao: data?.manutencao ? toMaintenanceTotals(data.manutencao) : null,
  };
}

export const saveGoalNote = (client: AppSupabaseClient, note: string) => call<null>(client, "set_goal_note", { p_note: note.trim() });
