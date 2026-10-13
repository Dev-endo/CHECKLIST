import type { AppSupabaseClient } from "./client";

export type QuarantineResult = "aprovado" | "reprovado";

export interface QuarantineEntry {
  serial: string;
  result: QuarantineResult;
  /** asset_short_id do aparelho, se estiver na planilha de ativos. */
  unit: string | null;
}

/** Grava todos os seriais bipados de uma vez, cada um com o seu resultado. */
export async function registerQuarantine(client: AppSupabaseClient, entries: readonly QuarantineEntry[]): Promise<void> {
  if (!entries.length) return;
  const { error } = await client
    .from("quarantine_checks")
    .insert(entries.map((entry) => ({ serial: entry.serial, result: entry.result, asset_short_id: entry.unit })));
  if (error) throw error;
}
