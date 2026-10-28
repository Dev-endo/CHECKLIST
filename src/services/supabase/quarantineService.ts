import { toDateInputValue } from "../../domain/device";
import type { AppSupabaseClient } from "./client";

export type QuarantineResult = "aprovado" | "reprovado";

export interface QuarantineEntry {
  serial: string;
  result: QuarantineResult;
  /** asset_short_id do aparelho, se estiver na planilha de ativos. */
  unit: string | null;
}

/** Grava todos os seriais bipados de uma vez, cada um com o seu resultado. */
export async function registerQuarantine(
  client: AppSupabaseClient,
  entries: readonly QuarantineEntry[],
): Promise<void> {
  if (!entries.length) return;
  const { error } = await client
    .from("quarantine_checks")
    .insert(
      entries.map((entry) => ({
        serial: entry.serial,
        result: entry.result,
        asset_short_id: entry.unit,
      })),
    );
  if (error) throw error;
}

export interface QuarantineDay {
  /** Dia no formato YYYY-MM-DD (horário local). */
  date: string;
  approved: number;
  rejected: number;
}

const PAGE = 1000;

/** Aprovados e reprovados por dia nos últimos `days` dias, do mais recente para o mais antigo. */
export async function fetchQuarantineDaily(
  client: AppSupabaseClient,
  days = 30,
): Promise<QuarantineDay[]> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  const byDay = new Map<string, QuarantineDay>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("quarantine_checks")
      .select("created_at, result")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data) {
      const date = toDateInputValue(new Date(row.created_at));
      const day = byDay.get(date) ?? { date, approved: 0, rejected: 0 };
      if (row.result === "aprovado") day.approved += 1;
      else day.rejected += 1;
      byDay.set(date, day);
    }
    if (data.length < PAGE) break;
  }
  return [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export interface QuarantineSerial {
  serial: string;
  result: QuarantineResult;
}

/** Seriais bipados na quarentena hoje (horário local), sem repetir, do mais recente para o mais antigo. */
export async function fetchQuarantineToday(
  client: AppSupabaseClient,
): Promise<QuarantineSerial[]> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows: QuarantineSerial[] = [];
  const seen = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("quarantine_checks")
      .select("serial, result")
      .gte("created_at", start.toISOString())
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data) {
      const key = row.serial.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        serial: row.serial,
        result: row.result === "aprovado" ? "aprovado" : "reprovado",
      });
    }
    if (data.length < PAGE) break;
  }
  return rows;
}
