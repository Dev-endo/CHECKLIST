import { parseOsMap, type OsMap } from "../../domain/serviceOrder";
import type { AppSupabaseClient } from "./client";
import type { MaintenanceReportFilters } from "./reportService";

/** Uma OS registrada para um ativo. */
export interface ServiceOrder {
  id: string;
  serial: string;
  osNumber: string;
  /** asset_short_id (ex.: "iPhone 14 128GB-2386"), do registro ou da planilha de ativos. */
  unit: string | null;
  model: string | null;
  createdAt: string;
  registeredBy: string;
}

interface OrderRow {
  id: string;
  serial: string;
  os_number: string;
  asset_short_id: string | null;
  created_at: string;
  profiles: { name: string; email: string } | null;
}

const SELECT = "id, serial, os_number, asset_short_id, created_at, profiles(name, email)";

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);
const startOfDay = (date: string) => new Date(`${date}T00:00:00`);

/** Completa unit id e modelo pela planilha de ativos, pelo serial. */
async function withAssets(client: AppSupabaseClient, rows: OrderRow[]): Promise<ServiceOrder[]> {
  const keys = [...new Set(rows.map((row) => row.serial.trim().toLowerCase()))];
  const assets = new Map<string, { unit: string; model: string | null }>();
  if (keys.length) {
    const { data, error } = await client
      .from("assets")
      .select("serial_key, asset_short_id, model")
      .in("serial_key", keys);
    if (error) throw error;
    for (const asset of data) if (asset.serial_key) assets.set(asset.serial_key, { unit: asset.asset_short_id, model: asset.model });
  }
  return rows.map((row) => {
    const asset = assets.get(row.serial.trim().toLowerCase());
    return {
      id: row.id,
      serial: row.serial,
      osNumber: row.os_number,
      unit: row.asset_short_id ?? asset?.unit ?? null,
      model: asset?.model ?? null,
      createdAt: row.created_at,
      registeredBy: row.profiles ? row.profiles.name || row.profiles.email : "—",
    };
  });
}

/** Todas as OS de um ativo (pelo serial), da mais antiga para a mais recente. */
export async function fetchAssetOrders(client: AppSupabaseClient, serial: string): Promise<ServiceOrder[]> {
  const { data, error } = await client
    .from("service_orders")
    .select(SELECT)
    .ilike("serial", escapeLike(serial.trim()))
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  return withAssets(client, data as unknown as OrderRow[]);
}

export type RegisterOrderResult = "ok" | "duplicate";

/** Registra a OS do ativo. "duplicate": esse número de OS já foi registrado. */
export async function registerServiceOrder(
  client: AppSupabaseClient,
  order: { serial: string; osNumber: string; unit: string | null },
): Promise<RegisterOrderResult> {
  const { error } = await client
    .from("service_orders")
    .insert({ serial: order.serial.trim(), os_number: order.osNumber.trim(), asset_short_id: order.unit });
  if (!error) return "ok";
  if (error.code === "23505") return "duplicate";
  throw error;
}

const SEARCH_LIMIT = 300;

/** Pesquisa de OS por número da OS, serial ou unit id, dentro do período (data de registro da OS). */
export async function searchServiceOrders(
  client: AppSupabaseClient,
  text: string,
  filters: Pick<MaintenanceReportFilters, "from" | "to">,
): Promise<ServiceOrder[]> {
  let query = client.from("service_orders").select(SELECT).order("created_at", { ascending: false }).limit(SEARCH_LIMIT);
  const term = text.trim();
  if (term) {
    const like = `%${escapeLike(term)}%`;
    query = query.or(`os_number.ilike.${like},serial.ilike.${like},asset_short_id.ilike.${like}`);
  }
  if (filters.from) query = query.gte("created_at", startOfDay(filters.from).toISOString());
  if (filters.to) {
    const nextDay = startOfDay(filters.to);
    nextDay.setDate(nextDay.getDate() + 1);
    query = query.lt("created_at", nextDay.toISOString());
  }
  const { data, error } = await query;
  if (error) throw error;
  return withAssets(client, data as unknown as OrderRow[]);
}

/** O mapa de uma OS; null se ela não existe ou a pessoa não tem acesso. */
export async function fetchOsMap(client: AppSupabaseClient, osId: string): Promise<OsMap | null> {
  const { data, error } = await client.rpc("os_map", { p_os_id: osId });
  if (error) throw error;
  return parseOsMap(data);
}
