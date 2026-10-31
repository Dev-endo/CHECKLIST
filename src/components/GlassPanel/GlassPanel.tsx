import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { canManageUsers } from "../../domain/roles";
import { useRepairTimer } from "../../hooks/useRepairTimer";
import { describeRepairError, STATUS_LABELS } from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { completeGlass, fetchGlassJobs, finishGlass, glassTimerApi, startGlass, type GlassJob } from "../../services/supabase/glassService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import { RepairTimer } from "../RepairStage1/RepairTimer";
import { useToast } from "../Toast/ToastProvider";
import styles from "./GlassPanel.module.css";

const POLL_MS = 10_000;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const ORIGIN_LABELS = { avaliacao: "Estágio 1: só vidro", manutencao: "Estágio 2: manutenção", analise: "Análise técnica: reparo em placa" } as const;
const STATE_LABELS = { aguardando: "Aguardando", em_andamento: "Em andamento", vidro_concluido: "Vidro concluído", concluido: "Entregue" } as const;

/** Cronômetro do vidro em andamento. */
function GlassTimer({ client, id, canAct, onError }: { client: AppSupabaseClient; id: string; canAct: boolean; onError: (error: unknown) => void }) {
  const timer = useRepairTimer(client, id, onError, glassTimerApi);
  return <RepairTimer title="Vidro" hideWait totals={timer.totals} action={timer.action} busy={timer.busy} disabled={!canAct} onToggle={() => void timer.toggle()} onFinish={() => void timer.finish()} />;
}

/** Aba Vidro: o técnico de vidro vê quem desmontou cada aparelho, o vidro e o aro do estoque, e entrega ao responsável. */
export function GlassPanel() {
  const { user, client } = useAuth();
  if (!client || !user) return <p className={appStyles.banner}>Entre com a sua conta para usar o Vidro.</p>;
  return <Glass client={client} userId={user.id} isAdmin={canManageUsers(user.roles)} />;
}

function Glass({ client, userId, isAdmin }: { client: AppSupabaseClient; userId: string; isAdmin: boolean }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<GlassJob[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

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
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, reloads]);

  const run = async (job: GlassJob, task: () => Promise<unknown>, done: string, fallback: string) => {
    setBusy(job.id);
    try {
      await task();
      toast(done);
      reload();
    } catch (error) {
      const text = (error as { message?: string })?.message ?? "";
      toast(
        text.includes("glass_pending")
          ? "O estoque ainda não entregou o vidro (o aro pode ser dispensado)."
          : describeRepairError(error as { code?: string; message?: string }, fallback),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Vidro</h1>
        <p className={appStyles.subtitle}>Aparelhos enviados para vidro. Ao terminar, entregue ao responsável: o aparelho volta para ele.</p>
      </header>

      {failed && (
        <div className={appStyles.banner} role="alert">
          Não foi possível carregar os serviços de vidro agora. Tentando de novo.
        </div>
      )}
      {jobs === null && !failed && <p className={styles.muted}>Carregando…</p>}
      {jobs?.length === 0 && <p className={styles.muted}>Nenhum aparelho esperando vidro.</p>}

      <ul className={styles.list}>
        {jobs?.map((job) => {
          const waitingGlass = job.parts.some((p) => p.part === "Vidro" && p.status !== "entregue");
          const loading = busy === job.id;
          const canAct = job.status === "aguardando" || job.startedById === userId || isAdmin;
          return (
            <li key={job.id} className={[styles.card, styles[`s_${job.status}`]].join(" ")}>
              <div className={styles.head}>
                <strong className={styles.serial}>{job.serial}</strong>
                <span>{job.model ?? "Modelo não encontrado"}</span>
                {job.unit && <span className={styles.muted}>{job.unit}</span>}
                <span className={styles.os}>OS {job.osNumber}</span>
                <span className={styles.state}>{STATE_LABELS[job.status]}</span>
              </div>
              <p className={styles.who}>
                Desmontado por <strong>{job.responsible}</strong> · {ORIGIN_LABELS[job.origin]} · pedido em {when(job.createdAt)}
              </p>
              <ul className={styles.parts}>
                {job.parts.map((p) => (
                  <li key={p.part} className={[styles.part, styles[`p_${p.status}`]].join(" ")}>
                    {p.part}: {p.status === "cancelada" && p.part === "Aro" ? "dispensado" : STATUS_LABELS[p.status]}
                  </li>
                ))}
              </ul>
              {job.status === "em_andamento" && (
                <GlassTimer client={client} id={job.id} canAct={canAct} onError={(error) => toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível atualizar o cronômetro."))} />
              )}
              <div className={styles.actions}>
                {job.status === "aguardando" && (
                  <Button disabled={loading} onClick={() => void run(job, () => startGlass(client, job.id), "Vidro iniciado", "Não foi possível iniciar o vidro.")}>
                    Começar vidro
                  </Button>
                )}
                {job.status === "em_andamento" && (
                  <Button
                    disabled={loading || waitingGlass || !canAct}
                    onClick={() => void run(job, () => completeGlass(client, job.id), "Vidro concluído", "Não foi possível concluir o vidro.")}
                  >
                    Concluir vidro
                  </Button>
                )}
                {job.status === "vidro_concluido" && (
                  <>
                    <Button
                      disabled={loading}
                      onClick={() =>
                        void run(job, () => finishGlass(client, job.id), `Entregue a ${job.responsible}`, "Não foi possível entregar o aparelho.")
                      }
                    >
                      Entregar ao responsável
                    </Button>
                    <Button
                      variant="danger"
                      disabled={loading}
                      onClick={() => {
                        if (!window.confirm(`O display morreu no processo? Um display será pedido ao estoque e o aparelho volta para ${job.responsible}.`)) return;
                        void run(job, () => finishGlass(client, job.id, true), `Display pedido ao estoque; aparelho devolvido a ${job.responsible}`, "Não foi possível pedir o display.");
                      }}
                    >
                      Solicitar display
                    </Button>
                  </>
                )}
                {job.status === "em_andamento" && !canAct && <span className={styles.muted}>Só quem começou o vidro (ou o admin) conclui.</span>}
                {waitingGlass && <span className={styles.muted}>Aguardando o estoque entregar o vidro.</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
