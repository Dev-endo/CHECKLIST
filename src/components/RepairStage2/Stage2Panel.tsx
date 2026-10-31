import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import {
  choiceTests,
  expectedOutcome,
  finishBlockers,
  OUTCOME_LABELS,
  PHASE_KIND,
  PHASE_LABELS,
  phaseCatalog,
  PHASES,
  requiredTests,
  type FinishDestination,
  type MaintenanceItem,
} from "../../domain/repairChecklist";
import { describeRepairError } from "../../domain/repairStages";
import { useRepairChecklists } from "../../hooks/useRepairChecklists";
import { useRepairDevice } from "../../hooks/useRepairDevice";
import { useRepairTimer } from "../../hooks/useRepairTimer";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  assemblyTimerApi,
  fetchMaintenanceItems,
  fetchMyOpenStages,
  finishMaintenance,
  maintenanceTimerApi,
  type OpenStage,
} from "../../services/supabase/repairService";
import { assetsBySerial } from "../../services/supabase/stockBoardService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import { Checklist } from "../Checklist/Checklist";
import { PartRequestForm } from "../RepairParts/PartRequestForm";
import { RequestList } from "../RepairParts/RequestList";
import { RepairTimer } from "../RepairStage1/RepairTimer";
import { useToast } from "../Toast/ToastProvider";
import { FinishPanel } from "./FinishPanel";
import { StageHistory } from "./StageHistory";
import stage1Styles from "../RepairStage1/RepairStage1.module.css";
import styles from "./RepairStage2.module.css";

const LIST_POLL_MS = 15_000;

/** Checklist manutenção (aparelhos antigos): os destinos possíveis. */
const LEGACY_DESTINATIONS: readonly { id: FinishDestination; label: string; hint: string }[] = [
  { id: "auto", label: "Quarentena", hint: "Tudo aprovado. Com algum teste reprovado, o aparelho vai para a Análise técnica." },
  { id: "analise", label: "Análise técnica", hint: "Entra na fila da Análise técnica, mesmo sem teste reprovado." },
  { id: "vidro", label: "Vidro", hint: "Pede Vidro e Aro ao estoque e abre o serviço na aba Vidro; depois o aparelho volta para você finalizar." },
];

const since = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

interface ReadyDevice extends OpenStage {
  /** Aguardando peças: o estágio abre sozinho quando o estoque resolver os pedidos da OS. */
  waiting: boolean;
  model: string | null;
  unit: string | null;
}

/** Reparo, Estágio 2: manutenção. Cronômetro, peças, checklists com o aparelho aberto e fechado e a finalização. */
interface Stage2PanelProps {
  /** A aba Análise técnica > Checklist e montagem usa a mesma tela, com outro título. */
  title?: string;
  subtitle?: string;
  /**
   * Análise técnica: só checklists e montagem (sem cronômetro de manutenção nem histórico); finaliza pelos testes
   * (aprovado vai para a quarentena).
   */
  assemblyOnly?: boolean;
  /** Abre direto este aparelho (sem passar pela lista). */
  initialSerial?: string;
  /** "Voltar" sai desta tela (em vez de voltar à lista). */
  onBack?: () => void;
  /** Aba Checklist manutenção (aparelhos antigos): só os checklists e o destino quarentena, análise técnica ou vidro. */
  legacy?: boolean;
  /** Sem o título da tela (quem usa já mostra o seu). */
  hideHeader?: boolean;
}

export function Stage2Panel({ title, subtitle, assemblyOnly = false, initialSerial, onBack, legacy = false, hideHeader = false }: Stage2PanelProps = {}) {
  const { user, client } = useAuth();
  if (!client || !user) {
    return <p className={appStyles.banner}>Entre com a sua conta para usar o Reparo.</p>;
  }
  return (
    <Stage2
      client={client}
      userId={user.id}
      technician={user.name || user.email}
      title={title}
      subtitle={subtitle}
      assemblyOnly={assemblyOnly}
      initialSerial={initialSerial}
      onBack={onBack}
      legacy={legacy}
      hideHeader={hideHeader}
    />
  );
}

interface Stage2Props {
  client: AppSupabaseClient;
  userId: string;
  technician: string;
  title?: string;
  subtitle?: string;
  assemblyOnly: boolean;
  initialSerial?: string;
  onBack?: () => void;
  legacy: boolean;
  hideHeader: boolean;
}

function Stage2({ client, userId, technician, title, subtitle, assemblyOnly, initialSerial, onBack, legacy, hideHeader }: Stage2Props) {
  const toast = useToast();
  // Aparelho escolhido na lista (sem bipar): o que já passou pelo Estágio 1 e espera a manutenção.
  const [serial, setSerial] = useState(initialSerial ?? "");
  const [ready, setReady] = useState<ReadyDevice[] | null>(null);
  const [mineReloads, setMineReloads] = useState(0);
  const [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState<FinishDestination>("auto");
  const [resaleReason, setResaleReason] = useState("");

  const { asset, order, stages, requests, returns, reload: reloadDevice } = useRepairDevice(client, serial, () =>
    toast("Não foi possível carregar o aparelho. Tente de novo."),
  );
  const reload = useCallback(() => {
    reloadDevice();
    setMineReloads((n) => n + 1);
  }, [reloadDevice]);

  const fail = useCallback(
    (error: unknown, fallback = "Não foi possível concluir a operação. Tente de novo.") =>
      toast(describeRepairError(error as { code?: string; message?: string }, fallback)),
    [toast],
  );

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchMyOpenStages(client, userId, ["manutencao"], ["em_andamento", "aguardando_pecas"], legacy)
        .then(async (found) => {
          const assets = await assetsBySerial(client, found.map((item) => item.serial)).catch(() => new Map());
          if (!active) return;
          setReady(
            found.map((item) => {
              const asset = assets.get(item.serial.trim().toLowerCase());
              return { ...item, waiting: item.status === "aguardando_pecas", model: asset?.model ?? null, unit: asset?.unit ?? null };
            }),
          );
        })
        .catch(() => active && setReady((current) => current ?? []));
    void load();
    const poll = setInterval(() => void load(), LIST_POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, userId, mineReloads, legacy]);

  const { disassembly, evaluation, maintenance } = stages;

  // Manutenções que contam para quem finaliza: relidas quando os pedidos de peça mudam.
  const [maintenanceItems, setMaintenanceItems] = useState<MaintenanceItem[]>([]);
  const maintenanceId = maintenance?.id;
  const partsKey = requests.map((r) => `${r.id}:${r.status}:${r.qtyDelivered}:${r.testDestiny ?? ""}`).join("|") + `#${returns.length}`;
  useEffect(() => {
    setMaintenanceItems([]);
    if (!maintenanceId) return;
    let active = true;
    fetchMaintenanceItems(client, maintenanceId)
      .then((items) => active && setMaintenanceItems(items))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, maintenanceId, partsKey]);
  const running = maintenance?.status === "em_andamento";
  const finished = maintenance?.status === "concluida";

  const onTimerError = (error: unknown) => fail(error, "Não foi possível atualizar o cronômetro.");
  // Manutenção e montagem: só um corre por vez (começar um para o outro), então os dois são relidos juntos.
  const timer = useRepairTimer(client, maintenance?.id, onTimerError, maintenanceTimerApi);
  const assembly = useRepairTimer(client, maintenance?.id, onTimerError, assemblyTimerApi);
  const refreshAssembly = assembly.refresh;
  const checklists = useRepairChecklists(client, maintenance?.id, running, (error) => fail(error, "Não foi possível salvar as marcações."));

  // Pedir peça pausa o cronômetro (espera de peça): relê a lista e o cronômetro juntos.
  const refreshTimer = timer.refresh;
  const afterRequestChange = useCallback(() => {
    reload();
    void refreshTimer();
    void refreshAssembly();
  }, [reload, refreshTimer, refreshAssembly]);

  const blockers = finishBlockers({
    results: checklists.results,
    requests,
    returnsWaiting: returns.filter((r) => r.status === "aguardando_recebimento").length,
    destination,
    resaleReason,
  });
  const outcome = expectedOutcome(checklists.results, destination);

  const finish = async () => {
    if (!maintenance || busy) return;
    const what = assemblyOnly ? "o checklist e a montagem" : legacy ? "o checklist" : "a manutenção";
    if (!window.confirm(`Finalizar ${what}? O aparelho vai para: ${OUTCOME_LABELS[outcome]}. Depois disso não dá para alterar.`)) return;
    setBusy(true);
    try {
      await checklists.flush();
      const result = await finishMaintenance(client, {
        stageId: maintenance.id,
        requiredOpen: requiredTests("aberto"),
        requiredClosed: requiredTests("fechado"),
        choice: [...choiceTests("aberto"), ...choiceTests("fechado")],
        destination,
        resaleReason,
      });
      toast(`Manutenção finalizada: ${OUTCOME_LABELS[result]}`);
      reload();
    } catch (error) {
      fail(error, "Não foi possível finalizar a manutenção.");
    } finally {
      setBusy(false);
    }
  };

  const choose = (item: OpenStage) => {
    setSerial(item.serial);
    window.scrollTo(0, 0);
  };

  const back = () => {
    if (onBack) {
      onBack();
      return;
    }
    setSerial("");
    setDestination("auto");
    setResaleReason("");
    setMineReloads((n) => n + 1);
  };

  return (
    <>
      {!hideHeader && (
      <header>
          <h1 className={appStyles.title}>{title ?? "Reparo · Estágio 2: manutenção"}</h1>
          <p className={appStyles.subtitle}>
            {subtitle ?? "Escolha o aparelho que já passou pelo Estágio 1, faça os testes com o aparelho aberto e fechado e finalize."}
          </p>
        </header>
      )}

      {!serial && (
        <section aria-label="Aparelhos">
          <h2 className={stage1Styles.heading}>{assemblyOnly ? "Aparelhos para checklist e montagem" : "Aparelhos para manutenção"}</h2>
          {ready === null && <p className={styles.muted}>Carregando…</p>}
          {ready?.length === 0 && (
            <p className={styles.muted}>
              {assemblyOnly
                ? "Nenhum aparelho esperando checklist e montagem. Eles chegam do Reparo em placa (destino Checklist e montagem → Quarentena)."
                : "Nenhum aparelho esperando manutenção. Conclua a desmontagem e a avaliação técnica no Estágio 1 para ele aparecer aqui."}
            </p>
          )}
          <ul className={styles.devices}>
            {ready?.map((item) => (
              <li key={item.id}>
                <button type="button" className={[styles.device, item.waiting ? styles.deviceWaiting : ""].join(" ")} onClick={() => choose(item)}>
                  <strong className={styles.deviceSerial}>{item.serial}</strong>
                  <span>{item.model ?? "Modelo não encontrado"}</span>
                  {item.unit && <span className={styles.muted}>{item.unit}</span>}
                  <span className={styles.deviceOs}>OS {item.osNumber}</span>
                  {item.waiting && <span className={styles.waitingTag}>Aguardando peças</span>}
                  <span className={styles.muted}>desde {since(item.startedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {serial && (
        <>
          <div className={stage1Styles.actions}>
            <Button variant="ghost" onClick={back}>
              {onBack ? "← Voltar" : "← Voltar à lista"}
            </Button>
          </div>
          <dl className={stage1Styles.info}>
            <div>
              <dt>Modelo</dt>
              <dd>{asset?.model ?? "Serial fora da lista de ativos"}</dd>
            </div>
            <div>
              <dt>Unit ID</dt>
              <dd>{asset?.assetShortId ?? "—"}</dd>
            </div>
            <div>
              <dt>Técnico</dt>
              <dd>{technician}</dd>
            </div>
            <div>
              <dt>OS</dt>
              <dd>{order?.osNumber ?? "Sem OS"}</dd>
            </div>
          </dl>

          {!order && <p className={stage1Styles.hint}>Este aparelho não tem OS. Registre a OS e faça o Estágio 1 primeiro.</p>}
          {order && !maintenance && (
            <p className={stage1Styles.hint}>
              Este aparelho ainda não chegou ao Estágio 2. Conclua a desmontagem e a avaliação técnica no Estágio 1.
            </p>
          )}

          {order && maintenance && (
            <div className={stage1Styles.block}>
              {finished && maintenance.outcome && (
                <p className={stage1Styles.done} role="status">
                  Manutenção finalizada. Destino: <strong>{OUTCOME_LABELS[maintenance.outcome]}</strong>.
                </p>
              )}

              {maintenance.status === "aguardando_pecas" && (
                <p className={stage1Styles.hint} role="status">
                  Aguardando peças: este aparelho abre sozinho para manutenção quando o estoque resolver todos os pedidos de peça da OS. Dá para
                  cancelar um pedido que não precisa mais.
                </p>
              )}

              {!assemblyOnly && !legacy && (
                <>
                  <h2 className={stage1Styles.heading}>Histórico da desmontagem</h2>
                  <StageHistory client={client} disassembly={disassembly} evaluation={evaluation} />
                </>
              )}

              {!legacy && (
                <>
              <h2 className={stage1Styles.heading}>{assemblyOnly ? "Troca de peça" : "Manutenção"}</h2>
              <RepairTimer
                title={assemblyOnly ? "Troca de peça" : "Manutenção"}
                totals={timer.totals}
                action={timer.action}
                busy={timer.busy}
                disabled={!running}
                onToggle={() => void timer.toggle().then(refreshAssembly)} onFinish={() => void timer.finish().then(refreshAssembly)}
              />

              <h2 className={stage1Styles.heading}>Montagem</h2>
              <RepairTimer
                title="Montagem"
                hideWait
                totals={assembly.totals}
                action={assembly.action}
                busy={assembly.busy}
                disabled={!running}
                onToggle={() => void assembly.toggle().then(refreshTimer)} onFinish={() => void assembly.finish().then(refreshTimer)}
              />
              <p className={stage1Styles.hint}>
                {assemblyOnly
                  ? "Sem troca de peça, use só a montagem. Os dois cronômetros não correm juntos: começar um para o outro."
                  : "Aparelho sem manutenção (ou já com o vidro feito) pode ser só montado. Os dois cronômetros não correm juntos: começar um para o outro."}
              </p>

              {running && <PartRequestForm client={client} serial={serial} onSent={afterRequestChange} />}

              <h2 className={stage1Styles.heading}>Solicitações de peça da OS {order.osNumber}</h2>
              <RequestList client={client} requests={requests} returns={returns} disabled={busy} onChanged={afterRequestChange} />

                </>
              )}

              {PHASES.map((phase) => (
                <section key={phase} className={styles.phase} aria-label={PHASE_LABELS[phase]}>
                  <h2 className={stage1Styles.heading}>{PHASE_LABELS[phase]}</h2>
                  {!checklists.loaded ? (
                    <p className={styles.muted}>Carregando…</p>
                  ) : (
                    <Checklist
                      kind={PHASE_KIND[phase]}
                      blocks={phaseCatalog(phase)}
                      results={checklists.phases[phase].results}
                      onToggle={(sectionId, result) => checklists.toggleResult(phase, sectionId, result)}
                      onToggleItem={(sectionId, itemId) => checklists.toggleItem(phase, sectionId, itemId)}
                      battery={checklists.phases[phase].battery}
                      onBatteryChange={(value) => checklists.setBattery(phase, value)}
                      onConfirm={(itemId, checked) => checklists.setConfirm(phase, itemId, checked)}
                      disabled={!running}
                    />
                  )}
                </section>
              ))}

              {running && (
                <FinishPanel
                  blockers={blockers}
                  outcome={outcome}
                  destination={destination}
                  resaleReason={resaleReason}
                  busy={busy}
                  unsaved={checklists.unsaved}
                  onDestination={setDestination}
                  onReason={setResaleReason}
                  onFinish={() => void finish()}
                  title={assemblyOnly ? "Finalizar checklist e montagem" : undefined}
                  onlyAuto={assemblyOnly}
                  destinations={legacy ? LEGACY_DESTINATIONS : undefined}
                  maintenanceItems={maintenanceItems}
                />
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
