import type { AppSupabaseClient } from "./client";
import { call } from "./repairService";

/** Aba "Defeito incorreto": peças cujo defeito não foi identificado, por ativo e por técnico (migration 102). */

export interface IncorrectDefectMine {
  serial: string;
  part: string;
  note: string | null;
  at: string;
}

export interface IncorrectDefectRow extends IncorrectDefectMine {
  osNumber: string | null;
  model: string | null;
  technician: string | null;
}

/** Registra as peças de um ativo; devolve quantas foram gravadas. */
export const registerIncorrectDefect = (client: AppSupabaseClient, serial: string, parts: readonly string[], note: string | null) =>
  call<number>(client, "register_incorrect_defect", { p_serial: serial, p_parts: [...parts], p_note: note });

export async function fetchMyIncorrectDefects(client: AppSupabaseClient): Promise<IncorrectDefectMine[]> {
  const found = await call<{ serial: string; part: string; note: string | null; at: string }[] | null>(client, "my_incorrect_defects_today");
  return (found ?? []).map((row) => ({ serial: row.serial, part: row.part, note: row.note, at: row.at }));
}

/** Análise (admin e supervisor): todas as peças registradas no período. */
export async function fetchIncorrectDefects(client: AppSupabaseClient, period: { from: string; to: string }): Promise<IncorrectDefectRow[]> {
  const found = await call<
    { serial: string; os_number: string | null; model: string | null; part: string; note: string | null; technician: string | null; at: string }[] | null
  >(client, "repair_incorrect_defects", { p_from: period.from, p_to: period.to });
  return (found ?? []).map((row) => ({
    serial: row.serial,
    osNumber: row.os_number,
    model: row.model,
    part: row.part,
    note: row.note,
    technician: row.technician,
    at: row.at,
  }));
}
