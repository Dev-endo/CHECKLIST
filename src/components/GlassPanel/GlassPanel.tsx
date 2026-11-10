import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { canManageUsers } from "../../domain/roles";
import { describeRepairError, STATUS_LABELS } from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  countGlassDoneSince,
  fetchGlassJobs,
  partsAllocated,
  type GlassJob,
} from "../../services/supabase/glassService";
import appStyles from "../../App.module.css";
import { GlassDirect } from "./GlassDirect";
import { GlassJobActions } from "./GlassJobActions";
import { useToast } from "../Toast/ToastProvider";
import styles from "./GlassPanel.module.css";

const POLL_MS = 10_000;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Filtro pelos quadros do topo. */
type Filter = "alocacao" | "processo" | null;

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

const ORIGIN_LABELS = {
  avaliacao: "Estágio 1: só vidro",
  manutencao: "Estágio 2: manutenção",
  analise: "Análise técnica: reparo em placa",
  vidro: "Direto no vidro",
} as const;
const STATE_LABELS = { aguardando: "Aguardando", em_andamento: "Em andamento", vidro_concluido: "Vidro concluído", concluido: "Entregue" } as const;

/** Cronômetro do vidro em andamento. */

/** Aba Vidro: o técnico de vidro vê quem desmontou cada aparelho, o vidro e o aro do estoque, e entrega ao responsável. */
export function GlassPanel() {
  const { user, client } = useAuth();
  if (!client || !user) return <p className={appStyles.banner}>Entre com a sua conta para usar o Vidro.</p>;
  return <Glass client={client} userId={user.id} isAdmin={canManageUsers(user.roles)} technician={user.name || user.email} />;
}

function Glass({ client, userId, isAdmin, technician }: { client: AppSupabaseClient; userId: string; isAdmin: boolean; technician: string }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<GlassJob[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const [doneToday, setDoneToday] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>(null);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchGlassJobs(client)
        .then((found) => {
          if (!active) return;
          setJobs(found);
          setFailed(false);
        })
        .catch(() => active && setFailed(true));
    const loadDone = () =>
      countGlassDoneSince(client, startOfToday())
        .then((n) => active && setDoneToday(n))
        .catch(() => undefined);
    void load();
    void loadDone();
    const poll = setInterval(() => {
      void load();
      void loadDone();
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, reloads]);

  // Ainda não começados: sem a peça (aguardando alocação) ou com a peça na mão (em processo).
  const notStarted = (jobs ?? []).filter((job) => job.status === "aguardando");
  const waitingParts = notStarted.filter((job) => !partsAllocated(job));
  const ready = notStarted.filter((job) => partsAllocated(job));
  const visible = filter === "alocacao" ? waitingParts : filter === "processo" ? ready : jobs;

  const run = async (job: GlassJob, task: () => Promise<unknown>, done: string, fallback: string) => {
    setBusy(job.id);
    try {
      await task();
      toast(done);
      reload();
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, fallback));
    } finally {
      setBusy(null);
    }
  };

  // O cartão do serviço de vidro (a lista e o fluxo "receber aparelho" usam o mesmo).
  const renderJob = (job: GlassJob) => {
    const loading = busy === job.id;
    const direct = job.origin === "vidro";
    return (
      <div className={[styles.card, styles[`s_${job.status}`]].join(" ")}>
        <div className={styles.head}>
          <strong className={styles.serial}>{job.serial}</strong>
          <span>{job.model ?? "Modelo não encontrado"}</span>
          {job.unit && <span className={styles.muted}>{job.unit}</span>}
          <span className={styles.os}>OS {job.osNumber}</span>
          <span className={styles.state}>{STATE_LABELS[job.status]}</span>
        </div>
        <p className={styles.who}>
          {direct ? "Recebido direto no vidro por" : "Desmontado por"} <strong>{job.responsible}</strong> · {ORIGIN_LABELS[job.origin]} · pedido em {when(job.createdAt)}
        </p>
        <ul className={styles.parts}>
          {job.parts.map((p) => (
            <li key={p.part} className={[styles.part, styles[`p_${p.status}`]].join(" ")}>
              {p.part}: {p.status === "cancelada" && p.part === "Aro" ? "dispensado" : STATUS_LABELS[p.status]}
            </li>
          ))}
        </ul>
        <GlassJobActions client={client} job={job} loading={loading} direct={direct} run={run} />
      </div>
    );
  };

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Vidro</h1>
        <p className={appStyles.subtitle}>
          Bipe o serial para receber um aparelho direto no vidro, ou atenda os enviados pelo Reparo. Conclua o vidro e responda o checklist de display. Tudo certo, o aparelho volta para quem desmontou; display com falha (ou solicitado), você escolhe quem faz.
        </p>
      </header>

      <GlassDirect client={client} userId={userId} isAdmin={isAdmin} technician={technician} jobs={jobs} renderJob={renderJob} reloadJobs={reload} />

      {failed && (
        <div className={appStyles.banner} role="alert">
          Não foi possível carregar os serviços de vidro agora. Tentando de novo.
        </div>
      )}
      <div className={styles.summary}>
        <button
          type="button"
          className={[styles.stat, styles.statWait, filter === "alocacao" ? styles.statOn : ""].join(" ")}
          aria-pressed={filter === "alocacao"}
          onClick={() => setFilter(filter === "alocacao" ? null : "alocacao")}
        >
          <span className={styles.statValue}>{jobs ? waitingParts.length : "…"}</span>
          <span className={styles.statLabel}>Aguardando alocação de peça</span>
          <span className={styles.muted}>o estoque ainda não entregou o vidro ou o aro</span>
        </button>
        <button
          type="button"
          className={[styles.stat, styles.statReady, filter === "processo" ? styles.statOn : ""].join(" ")}
          aria-pressed={filter === "processo"}
          onClick={() => setFilter(filter === "processo" ? null : "processo")}
        >
          <span className={styles.statValue}>{jobs ? ready.length : "…"}</span>
          <span className={styles.statLabel}>Em processo</span>
          <span className={styles.muted}>peça já alocada, aguardando concluir o vidro</span>
        </button>
        <div className={[styles.stat, styles.statDone].join(" ")}>
          <span className={styles.statValue}>{doneToday ?? "…"}</span>
          <span className={styles.statLabel}>Finalizados hoje</span>
          <span className={styles.muted}>vidros concluídos no dia</span>
        </div>
      </div>
      {filter && (
        <p className={styles.muted}>
          Mostrando só: {filter === "alocacao" ? "aguardando alocação de peça" : "em processo"}.{" "}
          <button type="button" className={styles.linkButton} onClick={() => setFilter(null)}>
            Ver todos
          </button>
        </p>
      )}

      {jobs === null && !failed && <p className={styles.muted}>Carregando…</p>}
      {jobs?.length === 0 && <p className={styles.muted}>Nenhum aparelho esperando vidro.</p>}
      {filter && jobs && jobs.length > 0 && visible?.length === 0 && <p className={styles.muted}>Nenhum aparelho nesta situação agora.</p>}

      <ul className={styles.list}>
        {visible?.map((job) => (
          <li key={job.id}>{renderJob(job)}</li>
        ))}
      </ul>
    </>
  );
}
