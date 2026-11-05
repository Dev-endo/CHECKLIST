import type { AppSupabaseClient } from "./client";
import { call } from "./repairService";

/** Aba Análise: balões, colaboradores (com desempenho diário) e peças, num período de dias (Brasília). */

export type DashboardKind = "quarentena" | "vidro" | "analise" | "reparos" | "bloqueados" | "aprovados" | "reprovados";

export interface DashboardSummary {
  quarentena: number;
  vidro: number;
  analise: number;
  /** Total de manutenções (placa = 1; cada peça usada de vez = 1). */
  reparos: number;
  /** Aparelhos com manutenção contada. */
  reparosAparelhos: number;
  /** Aparelhos finalizados com destino Bloqueado. */
  bloqueados: number;
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
  /** Peças de teste usadas de vez (já entram nas manutenções). */
  testesUsados: number;
  quarentena: number;
  /** Aparelhos que a pessoa liberou para o vidro. */
  vidroEnviados: number;
  /** Aparelhos que a pessoa liberou para a análise técnica. */
  analiseEnviados: number;
  placas: number;
  vidros: number;
}

export interface DashboardDay {
  day: string;
  manutencoes: number;
  /** Peças de teste usadas de vez (já entram nas manutenções). */
  testesUsados: number;
  /** Liberados para quarentena e vidro (meta do dia). */
  liberados: number;
  /** Justificativa do técnico por não bater a meta. */
  justificativa: string | null;
  quarentena: number;
  /** Aparelhos que a pessoa liberou para o vidro. */
  vidroEnviados: number;
  /** Aparelhos que a pessoa liberou para a análise técnica. */
  analiseEnviados: number;
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
    bloqueados: n("bloqueados"),
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
    {
      user_id: string;
      name: string;
      manutencoes: number;
      testes_usados?: number;
      quarentena: number;
      vidro_enviados: number;
      analise_enviados: number;
      placas: number;
      vidros: number;
    }[] | null
  >(client, "repair_dashboard_people", range(period));
  return (rows ?? []).map((row) => ({
    userId: row.user_id,
    name: row.name,
    manutencoes: Number(row.manutencoes),
    testesUsados: Number(row.testes_usados ?? 0),
    quarentena: Number(row.quarentena),
    vidroEnviados: Number(row.vidro_enviados),
    analiseEnviados: Number(row.analise_enviados),
    placas: Number(row.placas),
    vidros: Number(row.vidros),
  }));
}

export async function fetchPersonDaily(client: AppSupabaseClient, userId: string, period: Period): Promise<DashboardDay[]> {
  const rows = await call<
    | {
        day: string;
        manutencoes: number;
        testes_usados?: number;
        quarentena: number;
        vidro_enviados: number;
        analise_enviados: number;
        placas: number;
        vidros: number;
        justificativa?: string | null;
      }[]
    | null
  >(
    client,
    "repair_dashboard_person_daily",
    { p_user: userId, ...range(period) },
  );
  return (rows ?? []).map((row) => ({
    day: row.day,
    manutencoes: Number(row.manutencoes),
    testesUsados: Number(row.testes_usados ?? 0),
    liberados: Number(row.quarentena) + Number(row.vidro_enviados),
    justificativa: row.justificativa ?? null,
    quarentena: Number(row.quarentena),
    vidroEnviados: Number(row.vidro_enviados),
    analiseEnviados: Number(row.analise_enviados),
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

/** Manutenções e o caminho das peças (aparelhos finalizados no período). */
export interface MaintenanceTotals {
  aparelhos: number;
  /** Entregues pelo estoque, sem as substitutas e sem o vidro. */
  entregues: number;
  /** Peças de teste devolvidas ao estoque. */
  devolvidas: number;
  /** Devolvidas por defeito (a substituta entra no lugar; não soma manutenção). */
  substituidas: number;
  testesUsados: number;
  manutencoes: number;
}

export interface MaintenancePerson extends MaintenanceTotals {
  userId: string;
  name: string;
}

export interface MaintenanceDay extends MaintenanceTotals {
  day: string;
}

type TotalsRow = { aparelhos: number; entregues: number; devolvidas: number; substituidas: number; testes_usados: number; manutencoes: number };

export const toMaintenanceTotals = (row: Partial<TotalsRow> | null | undefined): MaintenanceTotals => ({
  aparelhos: Number(row?.aparelhos ?? 0),
  entregues: Number(row?.entregues ?? 0),
  devolvidas: Number(row?.devolvidas ?? 0),
  substituidas: Number(row?.substituidas ?? 0),
  testesUsados: Number(row?.testes_usados ?? 0),
  manutencoes: Number(row?.manutencoes ?? 0),
});

export async function fetchMaintenancePeople(client: AppSupabaseClient, period: Period): Promise<MaintenancePerson[]> {
  const rows = await call<(TotalsRow & { user_id: string; name: string })[] | null>(client, "repair_dashboard_maintenance", range(period));
  return (rows ?? []).map((row) => ({ userId: row.user_id, name: row.name, ...toMaintenanceTotals(row) }));
}

export async function fetchMaintenanceDaily(client: AppSupabaseClient, userId: string, period: Period): Promise<MaintenanceDay[]> {
  const rows = await call<(TotalsRow & { day: string })[] | null>(client, "repair_dashboard_maintenance_daily", { p_user: userId, ...range(period) });
  return (rows ?? []).map((row) => ({ day: row.day, ...toMaintenanceTotals(row) }));
}

/** Produtividade individual de um dia: meta (liberados para quarentena e vidro), justificativa e manutenções. */
export interface Productivity extends MaintenanceTotals {
  userId: string;
  name: string;
  liberados: number;
  quarentena: number;
  vidro: number;
  meta: number;
  batida: boolean;
  justificativa: string | null;
}

export interface ProductivityDevice {
  serial: string;
  model: string | null;
  unit: string | null;
  osNumber: string | null;
  origem: string;
  destino: string | null;
  at: string;
  manutencoes: number;
  /** Liberado para a quarentena ou o vidro: conta para a meta. */
  contaMeta: boolean;
}

export async function fetchProductivity(client: AppSupabaseClient, day: string): Promise<Productivity[]> {
  const rows = await call<
    | (TotalsRow & {
        user_id: string;
        name: string;
        liberados: number;
        quarentena: number;
        vidro: number;
        meta: number;
        batida: boolean;
        justificativa: string | null;
      })[]
    | null
  >(client, "repair_productivity", { p_day: day });
  return (rows ?? []).map((row) => ({
    ...toMaintenanceTotals(row),
    userId: row.user_id,
    name: row.name,
    liberados: Number(row.liberados),
    quarentena: Number(row.quarentena),
    vidro: Number(row.vidro),
    meta: Number(row.meta),
    batida: Boolean(row.batida),
    justificativa: row.justificativa,
  }));
}

export async function fetchProductivityDevices(client: AppSupabaseClient, userId: string, day: string): Promise<ProductivityDevice[]> {
  const rows = await call<
    | {
        serial: string;
        model: string | null;
        unit: string | null;
        os_number: string | null;
        origem: string;
        destino: string | null;
        at: string;
        manutencoes: number;
        conta_meta: boolean;
      }[]
    | null
  >(client, "repair_productivity_devices", { p_user: userId, p_day: day });
  return (rows ?? []).map((row) => ({
    serial: row.serial,
    model: row.model,
    unit: row.unit,
    osNumber: row.os_number,
    origem: row.origem,
    destino: row.destino,
    at: row.at,
    manutencoes: Number(row.manutencoes),
    contaMeta: Boolean(row.conta_meta),
  }));
}

/** Uma manutenção finalizada (aparelho), com o que contou e o caminho das peças. */
export interface MaintenanceDevice {
  at: string;
  serial: string;
  model: string | null;
  unit: string | null;
  osNumber: string | null;
  origem: string;
  destino: string | null;
  manutencoes: number;
  /** Ex.: "Bateria, Tela ×2 (teste usada de vez), Placa (…)". */
  itens: string | null;
  entregues: number;
  devolvidas: number;
  substituidas: number;
}

export async function fetchMaintenanceDevices(client: AppSupabaseClient, userId: string, period: Period): Promise<MaintenanceDevice[]> {
  const rows = await call<
    | {
        at: string;
        serial: string;
        model: string | null;
        unit: string | null;
        os_number: string | null;
        origem: string;
        destino: string | null;
        manutencoes: number;
        itens: string | null;
        entregues: number;
        devolvidas: number;
        substituidas: number;
      }[]
    | null
  >(client, "repair_dashboard_maintenance_devices", { p_user: userId, ...range(period) });
  return (rows ?? []).map((row) => ({
    at: row.at,
    serial: row.serial,
    model: row.model,
    unit: row.unit,
    osNumber: row.os_number,
    origem: row.origem,
    destino: row.destino,
    manutencoes: Number(row.manutencoes),
    itens: row.itens,
    entregues: Number(row.entregues ?? 0),
    devolvidas: Number(row.devolvidas ?? 0),
    substituidas: Number(row.substituidas ?? 0),
  }));
}
