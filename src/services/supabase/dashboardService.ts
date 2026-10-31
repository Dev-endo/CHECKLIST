import type { AppSupabaseClient } from "./client";
import { call } from "./repairService";

/** Aba Análise: balões, colaboradores (com desempenho diário) e peças, num período de dias (Brasília). */

export type DashboardKind = "quarentena" | "vidro" | "analise" | "reparos" | "aprovados" | "reprovados";

export interface DashboardSummary {
  quarentena: number;
  vidro: number;
  analise: number;
  /** Total de manutenções (placa = 1; cada peça usada de vez = 1). */
  reparos: number;
  /** Aparelhos com manutenção contada. */
  reparosAparelhos: number;
  aprovados: number;
  reprovados: number;
}

/** Uma linha de "aparelho por aparelho". */
export interface DashboardDevice {
  serial: string;
  osNumber: string | null;
  model: string | null;
  person: string | null;
  at: string;
  detail: string | null;
}

export interface DashboardPerson {
  userId: string;
  name: string;
  manutencoes: number;
  quarentena: number;
  /** Aparelhos que a pessoa liberou para o vidro. */
  vidroEnviados: number;
  placas: number;
  vidros: number;
}

export interface DashboardDay {
  day: string;
  manutencoes: number;
  quarentena: number;
  /** Aparelhos que a pessoa liberou para o vidro. */
  vidroEnviados: number;
  placas: number;
  vidros: number;
}

export interface DashboardPart {
  part: string;
  definitivas: number;
  testes: number;
  testesUsados: number;
  devolvidas: number;
  defeito: number;
}

interface Period {
  from: string;
  to: string;
}

const range = ({ from, to }: Period) => ({ p_from: from, p_to: to });

interface DeviceRow {
  serial: string;
  os_number: string | null;
  model: string | null;
  person: string | null;
  at: string;
  detail: string | null;
}

const toDevice = (row: DeviceRow): DashboardDevice => ({
  serial: row.serial,
  osNumber: row.os_number,
  model: row.model,
  person: row.person,
  at: row.at,
  detail: row.detail,
});

export async function fetchSummary(client: AppSupabaseClient, period: Period): Promise<DashboardSummary> {
  const data = await call<Record<string, number> | null>(client, "repair_dashboard_summary", range(period));
  const n = (key: string) => Number(data?.[key] ?? 0);
  return {
    quarentena: n("quarentena"),
    vidro: n("vidro"),
    analise: n("analise"),
    reparos: n("reparos"),
    reparosAparelhos: n("reparos_aparelhos"),
    aprovados: n("aprovados"),
    reprovados: n("reprovados"),
  };
}

export async function fetchDevices(client: AppSupabaseClient, kind: DashboardKind, period: Period): Promise<DashboardDevice[]> {
  const rows = await call<DeviceRow[] | null>(client, "repair_dashboard_devices", { p_kind: kind, ...range(period) });
  return (rows ?? []).map(toDevice);
}

export async function fetchPeople(client: AppSupabaseClient, period: Period): Promise<DashboardPerson[]> {
  const rows = await call<
    { user_id: string; name: string; manutencoes: number; quarentena: number; vidro_enviados: number; placas: number; vidros: number }[] | null
  >(client, "repair_dashboard_people", range(period));
  return (rows ?? []).map((row) => ({
    userId: row.user_id,
    name: row.name,
    manutencoes: Number(row.manutencoes),
    quarentena: Number(row.quarentena),
    vidroEnviados: Number(row.vidro_enviados),
    placas: Number(row.placas),
    vidros: Number(row.vidros),
  }));
}

export async function fetchPersonDaily(client: AppSupabaseClient, userId: string, period: Period): Promise<DashboardDay[]> {
  const rows = await call<{ day: string; manutencoes: number; quarentena: number; vidro_enviados: number; placas: number; vidros: number }[] | null>(
    client,
    "repair_dashboard_person_daily",
    { p_user: userId, ...range(period) },
  );
  return (rows ?? []).map((row) => ({
    day: row.day,
    manutencoes: Number(row.manutencoes),
    quarentena: Number(row.quarentena),
    vidroEnviados: Number(row.vidro_enviados),
    placas: Number(row.placas),
    vidros: Number(row.vidros),
  }));
}

export async function fetchParts(client: AppSupabaseClient, period: Period): Promise<DashboardPart[]> {
  const rows = await call<
    { part: string; definitivas: number; testes: number; testes_usados: number; devolvidas: number; defeito: number }[] | null
  >(client, "repair_dashboard_parts", range(period));
  return (rows ?? []).map((row) => ({
    part: row.part,
    definitivas: Number(row.definitivas),
    testes: Number(row.testes),
    testesUsados: Number(row.testes_usados),
    devolvidas: Number(row.devolvidas),
    defeito: Number(row.defeito),
  }));
}

export async function fetchPartDevices(client: AppSupabaseClient, part: string, period: Period): Promise<DashboardDevice[]> {
  const rows = await call<DeviceRow[] | null>(client, "repair_dashboard_part_devices", { p_part: part, ...range(period) });
  return (rows ?? []).map(toDevice);
}
