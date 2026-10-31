import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { describeRepairError, isOpenRequest } from "../../domain/repairStages";
import { canManageUsers } from "../../domain/roles";
import { useRepairTimer } from "../../hooks/useRepairTimer";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  boardTimerApi,
  fetchBoardRepairs,
  finishBoardRepair,
  startBoardRepair,
  type BoardDestination,
  type BoardItem,
} from "../../services/supabase/analysisTechService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import { RepairTimer } from "../RepairStage1/RepairTimer";
import { Stage2Panel } from "../RepairStage2/Stage2Panel";
import { useToast } from "../Toast/ToastProvider";
import type { StockRequest } from "../../services/supabase/repairService";
import { AnalysisParts } from "./AnalysisParts";
import { FinishBoardDialog } from "./FinishBoardDialog";
import styles from "./AnalysisTechPanel.module.css";

const POLL_MS = 10_000;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const DESTINATION_TOASTS: Record<BoardDestination, string> = {
  quarentena: "Reparo finalizado: faça os checklists e a montagem",
  vidro: "Reparo finalizado: o aparelho foi para o vidro",
  estagio2: "Reparo finalizado: o aparelho foi ao Estágio 2 de quem mandou para a análise",
};

/** Cronômetro do reparo em andamento: o tempo corre desde que o analista iniciou; dá para pausar e retomar. */
function BoardTimer({
  client,
  id,
  canAct,
  refreshKey,
  onError,
}: {
  client: AppSupabaseClient;
  id: string;
  canAct: boolean;
  /** Muda quando uma peça é pedida (o cronômetro passa a espera de peça). */
  refreshKey: number;
  onError: (error: unknown) => void;
}) {
  const timer = useRepairTimer(client, id, onError, boardTimerApi);
  const refresh = timer.refresh;
  useEffect(() => {
    if (refreshKey) void refresh();
  }, [refreshKey, refresh]);
  return <RepairTimer title="Reparo em placa" totals={timer.totals} action={timer.action} busy={timer.busy} disabled={!canAct} onToggle={() => void timer.toggle()} onFinish={() => void timer.finish()} />;
}

/** Peça de teste ainda aberta ou entregue sem destino: o reparo não finaliza. */
const partsPending = (requests: readonly StockRequest[]) =>
  requests.some((r) => isOpenRequest(r.status) || (r.status === "entregue" && r.purpose === "teste" && !r.testDestiny));

/** Aba Reparo em placa (segundo estágio da Análise técnica): o analista que fez a análise inicia e finaliza o reparo. */
export function BoardRepairPanel() {
  const { user, client } = useAuth();
  if (!client || !user) return <p className={appStyles.banner}>Entre com a sua conta para usar o Reparo em placa.</p>;
  return <Board client={client} userId={user.id} isAdmin={canManageUsers(user.roles)} />;
}

function Board({ client, userId, isAdmin }: { client: AppSupabaseClient; userId: string; isAdmin: boolean }) {
  const toast = useToast();
  const [items, setItems] = useState<BoardItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<BoardItem | null>(null);
  // Reparo finalizado para a quarentena: os checklists e a montagem abrem aqui mesmo.
  const [assembling, setAssembling] = useState<string | null>(null);
  const [partsByItem, setPartsByItem] = useState<Record<string, StockRequest[]>>({});
  const [timerKeys, setTimerKeys] = useState<Record<string, number>>({});
  const setParts = useCallback((id: string, requests: StockRequest[]) => setPartsByItem((prev) => ({ ...prev, [id]: requests })), []);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchBoardRepairs(client)
        .then((found) => {
          if (!active) return;
          setItems(found);
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

  const fail = (error: unknown, fallback: string) => {
    const text = (error as { message?: string })?.message ?? "";
    toast(text.includes("note_required") ? "Descreva o serviço feito na placa." : describeRepairError(error as { code?: string; message?: string }, fallback));
  };

  const start = async (item: BoardItem) => {
    setBusy(item.id);
    try {
      await startBoardRepair(client, item.id);
      toast("Reparo em placa iniciado");
      reload();
    } catch (error) {
      fail(error, "Não foi possível iniciar o reparo.");
    } finally {
      setBusy(null);
    }
  };

  const finish = async (note: string, destination: BoardDestination) => {
    if (!finishing) return;
    setBusy(finishing.id);
    try {
      await finishBoardRepair(client, finishing.id, note, destination);
      toast(DESTINATION_TOASTS[destination]);
      if (destination === "quarentena") setAssembling(finishing.serial);
      setFinishing(null);
      reload();
    } catch (error) {
      fail(error, "Não foi possível finalizar o reparo.");
    } finally {
      setBusy(null);
    }
  };

  if (assembling) {
    return (
      <Stage2Panel
        assemblyOnly
        initialSerial={assembling}
        title="Checklist e montagem"
        subtitle="Faça os checklists com o aparelho aberto e fechado e a montagem (com cronômetro). Tudo aprovado, o aparelho vai direto para a quarentena."
        onBack={() => {
          setAssembling(null);
          reload();
        }}
      />
    );
  }

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Reparo em placa</h1>
        <p className={appStyles.subtitle}>
          Aparelhos em que a análise indicou reparo em placa. Quem fez a análise inicia o reparo (o tempo conta) e finaliza com a observação do
          serviço feito: quarentena, vidro ou Estágio 2.
        </p>
      </header>

      {failed && (
        <div className={appStyles.banner} role="alert">
          Não foi possível carregar os reparos agora. Tentando de novo.
        </div>
      )}
      {items === null && !failed && <p className={styles.muted}>Carregando…</p>}
      {items?.length === 0 && <p className={styles.muted}>Nenhum aparelho esperando reparo em placa.</p>}

      <ul className={styles.list}>
        {items?.map((item) => {
          const owner = item.status === "aguardando" ? item.analystId === userId : item.startedById === userId;
          const canAct = owner || isAdmin;
          return (
            <li key={item.id} className={[styles.card, item.status === "em_andamento" ? styles.s_em_analise : ""].join(" ")}>
              <div className={styles.head}>
                <strong className={styles.serial}>{item.serial}</strong>
                <span>{item.model ?? "Modelo não encontrado"}</span>
                {item.unit && <span className={styles.muted}>{item.unit}</span>}
                <span className={styles.os}>OS {item.osNumber}</span>
                <span className={styles.state}>{item.status === "aguardando" ? "Aguardando reparo" : "Reparo em andamento"}</span>
              </div>
              <p className={styles.sentBy}>
                Enviado para a análise técnica por <strong>{item.sentBy}</strong>
                {item.sentAt ? ` em ${when(item.sentAt)}` : ""} · o aparelho volta para <strong>{item.sentBy}</strong>
              </p>
              <p className={styles.meta}>
                Análise de <strong>{item.analyst}</strong>
                {item.analysisFinishedAt ? ` (finalizada em ${when(item.analysisFinishedAt)})` : ""}
                {item.startedAt ? ` · reparo iniciado em ${when(item.startedAt)}` : ""}
              </p>
              {item.status === "em_andamento" && (
                <BoardTimer
                  client={client}
                  id={item.id}
                  canAct={canAct}
                  refreshKey={timerKeys[item.id] ?? 0}
                  onError={(error) => fail(error, "Não foi possível atualizar o cronômetro.")}
                />
              )}
              {item.status === "em_andamento" && item.analysisStartedAt && (
                <AnalysisParts
                  client={client}
                  analysisId={item.id}
                  startedAt={item.analysisStartedAt}
                  canAct={canAct}
                  onChange={(requests) => setParts(item.id, requests)}
                  onRequested={() => setTimerKeys((prev) => ({ ...prev, [item.id]: (prev[item.id] ?? 0) + 1 }))}
                />
              )}
              <div className={styles.actions}>
                {item.status === "aguardando" && (
                  <Button disabled={busy === item.id || !canAct} onClick={() => void start(item)}>
                    Iniciar reparo em placa
                  </Button>
                )}
                {item.status === "em_andamento" && (
                  <Button disabled={busy === item.id || !canAct || partsPending(partsByItem[item.id] ?? [])} onClick={() => setFinishing(item)}>
                    Finalizar reparo
                  </Button>
                )}
                {item.status === "em_andamento" && partsPending(partsByItem[item.id] ?? []) && (
                  <span className={styles.muted}>Resolva as peças de teste antes: aguarde a entrega e devolva ou use como definitiva.</span>
                )}
                {!canAct && <span className={styles.muted}>Só quem fez a análise ({item.analyst}) ou o admin mexe neste reparo.</span>}
              </div>
            </li>
          );
        })}
      </ul>

      <FinishBoardDialog open={Boolean(finishing)} busy={busy !== null} onCancel={() => setFinishing(null)} onConfirm={(note, destination) => void finish(note, destination)} />
    </>
  );
}
