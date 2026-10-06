import type { AssetRow } from "../../domain/csv";
import type { AppSupabaseClient } from "./client";
import type { Json } from "./database.types";

export interface Asset {
  /** Ex.: "iPhone 14 128GB-2386". */
  assetShortId: string;
  model: string;
}

/** Busca o ativo pelo serial bipado, sem diferenciar maiúsculas nem espaços nas pontas. */
export async function lookupAsset(client: AppSupabaseClient, serial: string): Promise<Asset | null> {
  const { data, error } = await client
    .from("assets")
    .select("asset_short_id, model")
    .eq("serial_key", serial.trim().toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return data && { assetShortId: data.asset_short_id, model: data.model ?? data.asset_short_id };
}

export interface ImportSummary {
  valid: number;
  inserted: number;
  existing: number;
  conflicts: number;
}

const BATCH_SIZE = 500;

/**
 * Envia em lotes; o banco insere só o que ainda não existe. Só o admin consegue
 * (política RLS). `onProgress` recebe quantas linhas já foram enviadas.
 */
export async function importAssets(
  client: AppSupabaseClient,
  rows: readonly AssetRow[],
  onProgress: (sent: number) => void,
): Promise<ImportSummary> {
  const total: ImportSummary = { valid: 0, inserted: 0, existing: 0, conflicts: 0 };
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const { data, error } = await client.rpc("import_assets", { rows: batch as unknown as Json });
    if (error) throw error;
    const part = data as unknown as ImportSummary;
    total.valid += part.valid;
    total.inserted += part.inserted;
    total.existing += part.existing;
    total.conflicts += part.conflicts;
    onProgress(Math.min(start + BATCH_SIZE, rows.length));
  }
  return total;
}

export async function countAssets(client: AppSupabaseClient): Promise<number> {
  const { count, error } = await client.from("assets").select("id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}
