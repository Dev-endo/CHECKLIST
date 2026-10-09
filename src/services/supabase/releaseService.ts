import type { DeviceRecord } from "../../domain/device";
import type { AppSupabaseClient } from "./client";
import { toRecord } from "./supabaseRepository";

/**
 * Dos checklists informados, quais são o último concluído do serial e estão liberados
 * ("liberado para montagem"). Quem fecha por último é quem vale.
 */
export async function fetchReleasedIds(client: AppSupabaseClient, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data, error } = await client.rpc("release_flags", { p_ids: [...ids] });
  if (error) throw error;
  return new Set(data.filter((row) => row.released).map((row) => row.device_id));
}

/** Todos os checklists de um serial, do mais antigo ao mais recente, com quem fez cada um. */
export async function fetchAssetHistory(client: AppSupabaseClient, serial: string): Promise<DeviceRecord[]> {
  const exact = serial.trim().replace(/[\\%_]/g, (char) => `\\${char}`);
  const { data, error } = await client
    .from("devices")
    .select("*, profiles(name, email)")
    .ilike("serial", exact)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return data.map(toRecord);
}
