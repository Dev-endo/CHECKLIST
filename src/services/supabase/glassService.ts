import type { RequestStatus } from "../../domain/repairStages";
import type { AppSupabaseClient } from "./client";
import { call, loose, rows, toTimerTotals, type TimerApi } from "./repairService";
import { assetsBySerial } from "./stockBoardService";

/** Aba Vidro: serviços de vidro abertos, com quem desmontou o aparelho e o estado do Vidro e do Aro no estoque. */

export interface GlassPart {
  part: "Vidro" | "Aro";
  status: RequestStatus;
}

export interface GlassJob {
  id: string;
  serial: string;
  osNumber: string;
  model: string | null;
  unit: string | null;
  origin: "avaliacao" | "manutencao" | "analise";
  /** vidro_concluido: o vidro terminou; falta entregar ao responsável (com ou sem pedido de display). */
  status: "aguardando" | "em_andamento" | "vidro_concluido" | "concluido";
  /** Quem desmontou o aparelho (o aparelho volta para ele). */
  responsible: string;
  /** Quem começou o vidro (só ele, ou o admin, pausa e conclui). */
  startedById: string | null;
  createdAt: string;
  parts: GlassPart[];
}

interface Person {
  name: string | null;
  email: string;
}

interface JobRow {
  id: string;
  os_id: string;
  serial: string;
  origin: GlassJob["origin"];
  status: GlassJob["status"];
  started_by: string | null;
  created_at: string;
  service_orders: { os_number: string } | null;
  profiles: Person | null;
}

const personName = (p: Person | null) => (p ? p.name?.trim() || p.email : "—");

export async function fetchGlassJobs(client: AppSupabaseClient): Promise<GlassJob[]> {
  const jobs = await rows<JobRow>(
    loose(client)
      .from("repair_glass_jobs")
      .select("id, os_id, serial, origin, status, started_by, created_at, service_orders(os_number), profiles!responsible_id(name, email)")
      .neq("status", "concluido")
      .order("created_at", { ascending: true })
      .limit(200),
  );
  if (!jobs.length) return [];
  const [requests, assets] = await Promise.all([
    rows<{ os_id: string; part: string; status: RequestStatus; created_at: string }>(
      loose(client)
        .from("stock_requests")
        .select("os_id, part, status, created_at")
        .in("os_id", jobs.map((job) => job.os_id))
        .in("part_key", ["vidro", "aro"])
        .order("created_at", { ascending: false }),
    ),
    assetsBySerial(client, jobs.map((job) => job.serial)),
  ]);
  return jobs.map((job) => {
    const asset = assets.get(job.serial.trim().toLowerCase());
    // O pedido mais recente de cada peça (um vidro novo pode ter sido pedido de novo).
    const parts = (["Vidro", "Aro"] as const).flatMap((part) => {
      const found = requests.find((r) => r.os_id === job.os_id && r.part.toLowerCase() === part.toLowerCase());
      return found ? [{ part, status: found.status }] : [];
    });
    return {
      id: job.id,
      serial: job.serial,
      osNumber: job.service_orders?.os_number ?? "—",
      model: asset?.model ?? null,
      unit: asset?.unit ?? null,
      origin: job.origin,
      status: job.status,
      responsible: personName(job.profiles),
      startedById: job.started_by,
      createdAt: job.created_at,
      parts,
    };
  });
}

export const startGlass = (client: AppSupabaseClient, jobId: string) => call<null>(client, "start_glass", { p_job_id: jobId });

/** Concluir vidro: para o cronômetro (precisa do vidro entregue pelo estoque). */
export const completeGlass = (client: AppSupabaseClient, jobId: string) => call<null>(client, "complete_glass", { p_job_id: jobId });

/**
 * Entrega o aparelho ao responsável: ele volta ao Estágio 2 de quem desmontou. Com `display`, o display morreu no
 * processo: já pede um display ao estoque, na manutenção do responsável.
 */
export const finishGlass = (client: AppSupabaseClient, jobId: string, display = false) =>
  call<string>(client, "finish_glass", { p_job_id: jobId, p_display: display });

/** Cronômetro do vidro: liga ao começar, pausa e retoma, para ao concluir. */
export const glassTimerApi: TimerApi = {
  fetch: async (client, id) => toTimerTotals(await call(client, "glass_timer_totals", { p_job_id: id })),
  set: (client, id, kind) => call<null>(client, "glass_timer_set", { p_job_id: id, p_kind: kind }),
};
