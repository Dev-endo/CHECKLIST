import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { canDirectFromGlass, canManageUsers } from "../../domain/roles";
import { serialKey } from "../../domain/labDay";
import { fetchGlassSerials } from "../../services/supabase/labDayService";
import { AssignAssets } from "../LabDay/AssignAssets";
import { Button } from "../Button/Button";
import { describeRepairError } from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  countGlassDoneSince,
  fetchGlassJobs,
  type GlassJob,
} from "../../services/supabase/glassService";
import appStyles from "../../App.module.css";
import { GlassDirect } from "./GlassDirect";
import { GlassJobActions } from "./GlassJobActions";
import { useToast } from "../Toast/ToastProvider";
import styles from "./GlassPanel.module.css";

const POLL_MS = 10_000;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

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
  return (
    <Glass
      client={client}
      userId={user.id}
      isAdmin={canManageUsers(user.roles)}
      technician={user.name || user.email}
      canDirect={canDirectFromGlass(user.roles)}
    />
  );
}

function Glass({ client, userId, isAdmin, technician, canDirect }: { client: AppSupabaseClient; userId: string; isAdmin: boolean; technician: string; canDirect: boolean }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<GlassJob[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const [doneToday, setDoneToday] = useState<number | null>(null);
  // Dia Laboratório: seriais com status Vidro (direcionados para um técnico, não voltam sozinhos).
  const [labGlass, setLabGlass] = useState<Set<string>>(new Set());
  const [directing, setDirecting] = useState(false);

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
    const loadLab = () =>
      fetchGlassSerials(client)
        .then((found) => active && setLabGlass(found))
        .catch(() => undefined);
    void load();
    void loadDone();
    void loadLab();
    const poll = setInterval(() => {
      void load();
      void loadDone();
      void loadLab();
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, reloads]);

  // O vidro não usa o estoque: ou espera concluir o vidro, ou espera o checklist de display e a entrega.
  const waitingGlass = (jobs ?? []).filter((job) => job.status !== "vidro_concluido");
  const waitingDisplay = (jobs ?? []).filter((job) => job.status === "vidro_concluido");
  const visible = jobs;

  const run = async (job: GlassJob, task: () => Promise<unknown>, done: string, fallback: string) => {
    setBusy(job.id);
    try {
      await task();
      toast(done);
      reload();
    } catch (error) {
      const err = error as { code?: string; message?: string };
      const known = describeRepairError(err, fallback);
      // Erro não reconhecido: mostra o motivo técnico para facilitar o diagnóstico.
      toast(known === fallback && err?.message ? `${fallback} (${err.message})` : known);
    } finally {
      setBusy(null);
    }
  };

  // O cartão do serviço de vidro (a lista e o fluxo "receber aparelho" usam o mesmo).
  const renderJob = (job: GlassJob) => {
    const loading = busy === job.id;
    const direct = job.origin === "vidro";
    const labDirect = labGlass.has(serialKey(job.serial));
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
        {labDirect && <p className={styles.who}>Dia Laboratório: depois do vidro, direcione para um técnico (não volta sozinho).</p>}
        <GlassJobActions client={client} job={job} loading={loading} direct={direct} run={run} labDirect={labDirect} />
      </div>
    );
  };

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Vidro</h1>
        <p className={appStyles.subtitle}>
          Bipe o serial para receber um aparelho direto no vidro, ou atenda os enviados pelo Reparo. Conclua o vidro e responda o checklist de display. Tudo certo, o aparelho volta para quem desmontou (ou o vidro é finalizado, se chegou direto); display com falha (ou solicitado), você escolhe quem faz.
        </p>
      </header>

      {canDirect && (
        <section aria-label="Direcionar para técnico">
          <Button variant={directing ? "ghost" : "primary"} onClick={() => setDirecting((value) => !value)}>
            {directing ? "Fechar direcionamento" : `Direcionar para técnico${labGlass.size ? ` (${labGlass.size} no Vidro)` : ""}`}
          </Button>
          {directing && <AssignAssets client={client} mode="vidro" onDone={reload} />}
        </section>
      )}

      <GlassDirect client={client} userId={userId} isAdmin={isAdmin} technician={technician} jobs={jobs} renderJob={renderJob} reloadJobs={reload} />

      {failed && (
        <div className={appStyles.banner} role="alert">
          Não foi possível carregar os serviços de vidro agora. Tentando de novo.
        </div>
      )}
      <div className={styles.summary}>
        <div className={[styles.stat, styles.statWait].join(" ")}>
          <span className={styles.statValue}>{jobs ? waitingGlass.length : "…"}</span>
          <span className={styles.statLabel}>Aguardando vidro</span>
          <span className={styles.muted}>enviados pelo Reparo, falta concluir o vidro</span>
        </div>
        <div className={[styles.stat, styles.statReady].join(" ")}>
          <span className={styles.statValue}>{jobs ? waitingDisplay.length : "…"}</span>
          <span className={styles.statLabel}>Checklist de display</span>
          <span className={styles.muted}>vidro concluído, falta testar o display e entregar</span>
        </div>
        <div className={[styles.stat, styles.statDone].join(" ")}>
          <span className={styles.statValue}>{doneToday ?? "…"}</span>
          <span className={styles.statLabel}>Finalizados hoje</span>
          <span className={styles.muted}>vidros concluídos no dia</span>
        </div>
      </div>

      {jobs === null && !failed && <p className={styles.muted}>Carregando…</p>}
      {jobs?.length === 0 && <p className={styles.muted}>Nenhum aparelho esperando vidro.</p>}
      
      <ul className={styles.list}>
        {visible?.map((job) => (
          <li key={job.id}>{renderJob(job)}</li>
        ))}
      </ul>
    </>
  );
}
