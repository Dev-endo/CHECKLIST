import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { describeFailedTest } from "../../domain/repairChecklist";
import { canManageUsers } from "../../domain/roles";
import { describeRepairError, isOpenRequest } from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { useRepairTimer } from "../../hooks/useRepairTimer";
import {
  analysisTimerApi,
  fetchAnalysisQueue,
  finishAnalysis,
  startAnalysis,
  type AnalysisItem,
  type AnalysisPart,
  type AnalysisResult,
} from "../../services/supabase/analysisTechService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import { RepairTimer } from "../RepairStage1/RepairTimer";
import { useToast } from "../Toast/ToastProvider";
import type { StockRequest } from "../../services/supabase/repairService";
import { Stage2Panel } from "../RepairStage2/Stage2Panel";
import { AnalysisParts } from "./AnalysisParts";
import { FinishAnalysisDialog } from "./FinishAnalysisDialog";
import styles from "./AnalysisTechPanel.module.css";

const POLL_MS = 10_000;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const SOURCE_LABELS = { estagio1: "Veio do Estágio 1", manutencao: "Manutenção reprovada" } as const;

/** Aba Análise técnica: fila de aparelhos; o analista começa a análise e finaliza com troca de periférico ou reparo em placa. */
export function AnalysisTechPanel() {
  const { user, client } = useAuth();
  if (!client || !user) return <p className={appStyles.banner}>Entre com a sua conta para usar a Análise técnica.</p>;
  return <Analysis client={client} userId={user.id} isAdmin={canManageUsers(user.roles)} />;
}

/** Cronômetro de uma análise em andamento: o tempo corre desde que o analista começou; dá para pausar e retomar. */
function AnalysisTimer({
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
  const timer = useRepairTimer(client, id, onError, analysisTimerApi);
  const refresh = timer.refresh;
  useEffect(() => {
    if (refreshKey) void refresh();
  }, [refreshKey, refresh]);
  return <RepairTimer title="Análise técnica" totals={timer.totals} action={timer.action} busy={timer.busy} disabled={!canAct} onToggle={() => void timer.toggle()} onFinish={() => void timer.finish()} />;
}

/** Peça de teste da análise ainda aberta ou entregue sem destino: a análise não finaliza. */
const partsPending = (requests: readonly StockRequest[]) =>
  requests.some((r) => isOpenRequest(r.status) || (r.status === "entregue" && r.purpose === "teste" && !r.testDestiny));

/** Peças de teste que o analista decidiu usar como definitivas (vão junto com o aparelho). */
const keptParts = (requests: readonly StockRequest[]) => requests.filter((r) => r.testDestiny === "utilizacao_definitiva").map((r) => r.part);

function Analysis({ client, userId, isAdmin }: { client: AppSupabaseClient; userId: string; isAdmin: boolean }) {
  const toast = useToast();
  const [items, setItems] = useState<AnalysisItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<AnalysisItem | null>(null);
  // Troca feita pelo próprio analista: a tela de troca, checklist e montagem abre aqui mesmo.
  const [assembling, setAssembling] = useState<string | null>(null);
  // Peças de teste de cada análise em andamento (vêm do cartão) e o "recarregar" do cronômetro de cada uma.
  const [partsByItem, setPartsByItem] = useState<Record<string, StockRequest[]>>({});
  const [timerKeys, setTimerKeys] = useState<Record<string, number>>({});
  const setParts = useCallback((id: string, requests: StockRequest[]) => setPartsByItem((prev) => ({ ...prev, [id]: requests })), []);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchAnalysisQueue(client)
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
    toast(
      text.includes("parts_required")
        ? "Marque as peças que serão trocadas."
        : describeRepairError(error as { code?: string; message?: string }, fallback),
    );
  };

  const start = async (item: AnalysisItem) => {
    setBusy(item.id);
    try {
      await startAnalysis(client, item.id);
      toast("Análise iniciada");
      reload();
    } catch (error) {
      fail(error, "Não foi possível iniciar a análise.");
    } finally {
      setBusy(null);
    }
  };

  // A peça de teste resolveu: o aparelho vai com ela para o Estágio 2 de quem mandou, sem pedir outra peça.
  const deliver = async (item: AnalysisItem, kept: string[], self = false) => {
    const question = self
      ? `Fazer você mesmo a troca com: ${kept.join(", ")}? Em seguida abrem os checklists e a montagem.`
      : `Entregar o aparelho a ${item.sentBy} com: ${kept.join(", ")}? A análise termina como troca de periférico.`;
    if (!window.confirm(question)) return;
    setBusy(item.id);
    try {
      await finishAnalysis(client, item.id, "troca_periferico", [], self);
      toast(self ? "Troca com você: faça os checklists e a montagem" : `Aparelho entregue ao Estágio 2 de ${item.sentBy}, com ${kept.join(", ")}`);
      if (self) setAssembling(item.serial);
      reload();
    } catch (error) {
      fail(error, "Não foi possível entregar o aparelho.");
    } finally {
      setBusy(null);
    }
  };

  const finish = async (result: AnalysisResult, parts: AnalysisPart[], self: boolean) => {
    if (!finishing) return;
    setBusy(finishing.id);
    try {
      await finishAnalysis(client, finishing.id, result, parts, self);
      toast(
        result === "troca_periferico" && self
          ? "Análise finalizada: faça a troca, os checklists e a montagem"
          : result === "troca_periferico"
          ? `Análise finalizada: ${parts.length} peça(s) pedida(s) e aparelho enviado ao Estágio 2 de ${finishing.sentBy}`
          : "Análise finalizada: o aparelho está na aba Reparo em placa",
      );
      if (result === "troca_periferico" && self) setAssembling(finishing.serial);
      setFinishing(null);
      reload();
    } catch (error) {
      fail(error, "Não foi possível finalizar a análise.");
    } finally {
      setBusy(null);
    }
  };

  if (assembling) {
    return (
      <Stage2Panel
        assemblyOnly
        initialSerial={assembling}
        title="Troca, checklist e montagem"
        subtitle="Receba as peças, faça a troca (cronômetro da troca), os checklists com o aparelho aberto e fechado e a montagem. Tudo aprovado, o aparelho vai direto para a quarentena."
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
        <h1 className={appStyles.title}>Análise técnica</h1>
        <p className={appStyles.subtitle}>
          Aparelhos enviados pelo Estágio 1 ou reprovados na manutenção. Comece a análise e, ao finalizar, escolha troca de periférico ou reparo
          em placa: o aparelho volta ao Estágio 2 de quem o mandou para a análise.
        </p>
      </header>

      {failed && (
        <div className={appStyles.banner} role="alert">
          Não foi possível carregar a fila agora. Tentando de novo.
        </div>
      )}
      {items === null && !failed && <p className={styles.muted}>Carregando…</p>}
      {items?.length === 0 && <p className={styles.muted}>Nenhum aparelho esperando análise.</p>}

      <ul className={styles.list}>
        {items?.map((item) => {
          const mine = item.startedById === userId;
          return (
            <li key={item.id} className={[styles.card, styles[`s_${item.status}`]].join(" ")}>
              <div className={styles.head}>
                <strong className={styles.serial}>{item.serial}</strong>
                <span>{item.model ?? "Modelo não encontrado"}</span>
                {item.unit && <span className={styles.muted}>{item.unit}</span>}
                <span className={styles.os}>OS {item.osNumber}</span>
                <span className={styles.state}>{item.status === "aguardando" ? "Aguardando" : "Em análise"}</span>
              </div>
              <p className={styles.sentBy}>
                Enviado para a análise técnica por <strong>{item.sentBy}</strong>
                {item.sentAt ? ` em ${when(item.sentAt)}` : ""} · o aparelho volta para <strong>{item.sentBy}</strong>
              </p>
              <p className={styles.meta}>
                {SOURCE_LABELS[item.source]} · na fila desde {when(item.createdAt)}
                {item.startedBy && item.startedAt ? ` · análise de ${item.startedBy} desde ${when(item.startedAt)}` : ""}
              </p>
              {item.failedTests.length > 0 && (
                <ul className={styles.failed} aria-label="Testes reprovados">
                  {item.failedTests.map((entry) => (
                    <li key={`${entry.fase}-${entry.teste ?? entry.item}`}>{describeFailedTest(entry)}</li>
                  ))}
                </ul>
              )}
              {item.status === "em_analise" && (
                <AnalysisTimer
                  client={client}
                  id={item.id}
                  canAct={mine || isAdmin}
                  refreshKey={timerKeys[item.id] ?? 0}
                  onError={(error) => fail(error, "Não foi possível atualizar o cronômetro.")}
                />
              )}
              {item.status === "em_analise" && item.startedAt && (
                <AnalysisParts
                  client={client}
                  analysisId={item.id}
                  startedAt={item.startedAt}
                  canAct={mine || isAdmin}
                  onChange={(requests) => setParts(item.id, requests)}
                  onRequested={() => setTimerKeys((prev) => ({ ...prev, [item.id]: (prev[item.id] ?? 0) + 1 }))}
                />
              )}
              <div className={styles.actions}>
                {item.status === "aguardando" && (
                  <Button disabled={busy === item.id} onClick={() => void start(item)}>
                    Começar análise
                  </Button>
                )}
                {item.status === "em_analise" && keptParts(partsByItem[item.id] ?? []).length > 0 && !partsPending(partsByItem[item.id] ?? []) && (
                  <Button disabled={busy === item.id || !(mine || isAdmin)} onClick={() => void deliver(item, keptParts(partsByItem[item.id] ?? []))}>
                    Entregar ao técnico com {keptParts(partsByItem[item.id] ?? []).join(", ")}
                  </Button>
                )}
                {item.status === "em_analise" && keptParts(partsByItem[item.id] ?? []).length > 0 && !partsPending(partsByItem[item.id] ?? []) && (
                  <Button
                    variant="ghost"
                    disabled={busy === item.id || !(mine || isAdmin)}
                    onClick={() => void deliver(item, keptParts(partsByItem[item.id] ?? []), true)}
                  >
                    Eu mesmo faço a troca
                  </Button>
                )}
                {item.status === "em_analise" && (
                  <>
                    <Button
                      variant={keptParts(partsByItem[item.id] ?? []).length > 0 ? "ghost" : "primary"}
                      disabled={busy === item.id || partsPending(partsByItem[item.id] ?? [])}
                      onClick={() => setFinishing(item)}
                    >
                      Finalizar análise
                    </Button>
                    {partsPending(partsByItem[item.id] ?? []) && (
                      <span className={styles.muted}>Resolva as peças de teste antes: aguarde a entrega e devolva ou use como definitiva.</span>
                    )}
                    {!mine && !isAdmin && <span className={styles.muted}>Só quem começou a análise (ou o admin) finaliza.</span>}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <FinishAnalysisDialog
        open={Boolean(finishing)}
        busy={busy !== null}
        keptParts={finishing ? keptParts(partsByItem[finishing.id] ?? []) : []}
        onCancel={() => setFinishing(null)}
        onConfirm={(result, parts, self) => void finish(result, parts, self)}
      />
    </>
  );
}
