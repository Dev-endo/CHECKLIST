import type { DeviceRecord } from "../../domain/device";
import type { AppSupabaseClient } from "./client";
import { toRecord } from "./supabaseRepository";

export const REVIEW_LIMIT = 200;

export interface ReviewFilters {
  /** Datas no formato YYYY-MM-DD (campo de data do navegador), ou vazio. */
  from: string;
  to: string;
  /** Id do colaborador, ou vazio para todos. */
  userId: string;
  serial: string;
}

const startOfDay = (date: string) => new Date(`${date}T00:00:00`);

/** Escapa os curingas do LIKE para o serial ser buscado como texto literal. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

export interface ReviewResult {
  records: DeviceRecord[];
  /** Total que bate com os filtros, mesmo além do limite de linhas mostradas. */
  total: number;
}

/** Checklists de todos os usuários, para supervisor e admin (RLS libera só esses papéis). */
export async function fetchReviewRecords(client: AppSupabaseClient, filters: ReviewFilters): Promise<ReviewResult> {
  let query = client
    .from("devices")
    .select("*, profiles(name, email)", { count: "exact" })
    .eq("kind", "manutencao")
    .order("created_at", { ascending: false })
    .limit(REVIEW_LIMIT);

  if (filters.userId) query = query.eq("user_id", filters.userId);
  const serial = filters.serial.trim();
  if (serial) query = query.ilike("serial", `%${escapeLike(serial)}%`);
  if (filters.from) query = query.gte("created_at", startOfDay(filters.from).toISOString());
  if (filters.to) {
    const nextDay = startOfDay(filters.to);
    nextDay.setDate(nextDay.getDate() + 1);
    query = query.lt("created_at", nextDay.toISOString());
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return { records: data.map(toRecord), total: count ?? data.length };
}
