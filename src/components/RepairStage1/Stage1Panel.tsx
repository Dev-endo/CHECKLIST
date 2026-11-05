import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { ANALYSIS_NOTE_MIN, MISSING_PARTS_CATALOG, missingPartsPending } from "../../domain/repairChecklist";
import {
  describeRepairError,
  destinationAvailable,
  deviceWhereabouts,
  GLASS_LABELS,
  isOpenRequest,
  STAGE1_DESTINATIONS,
  stage1Destinations,
  type GlassAnswer,
  type Stage1Destination,
} from "../../domain/repairStages";
import { useRepairChecklists } from "../../hooks/useRepairChecklists";
import { useRepairDevice } from "../../hooks/useRepairDevice";
import { useRepairTimer } from "../../hooks/useRepairTimer";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  fetchMyOpenStages,
  finishDisassembly,
  finishEvaluation,
  setTimer,
  startDisassembly,
  type OpenStage,
} from "../../services/supabase/repairService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import { ChoiceCards } from "../ChoiceCards/ChoiceCards";
import { Checklist } from "../Checklist/Checklist";
import { OsField } from "../DeviceForm/OsField";
import { PartRequestForm } from "../RepairParts/PartRequestForm";
import { RequestList } from "../RepairParts/RequestList";
import { useToast } from "../Toast/ToastProvider";
import { RepairTimer } from "./RepairTimer";
import styles from "./RepairStage1.module.css";

const LOOKUP_DEBOUNCE_MS = 400;

/** Reparo, Estágio 1: desmontagem e, em seguida, avaliação técnica. Serial, OS, cronômetros e pedidos de peça. */
export function Stage1Panel() {
  const { user, client } = useAuth();
  if (!client || !user) {
    return <p className={appStyles.banner}>Entre com a sua conta para usar o Reparo.</p>;
  }
  return <Stage1 client={client} userId={user.id} technician={user.name || user.email} />;
}

interface Stage1Props {
  client: AppSupabaseClient;
  userId: string;
  technician: string;
}

function Stage1({ client, userId, technician }: Stage1Props) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [serial, setSerial] = useState("");
  const [mine, setMine] = useState<OpenStage[]>([]);
  const [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState<Stage1Destination>("manutencao");
  // "O aparelho é vidro?": obrigatório antes de concluir a avaliação técnica.
  const [glass, setGlass] = useState<GlassAnswer | null>(null);
  const allowed = stage1Destinations(glass);
  const chosen: Stage1Destination | null = allowed.includes(destination) ? destination : (allowed[0] ?? null);
  // Motivo do envio para a Análise técnica (obrigatório nesse destino).
  const [analysisNote, setAnalysisNote] = useState("");
  const noteMissing = chosen === "analise" && analysisNote.trim().length < ANALYSIS_NOTE_MIN;
  // Ativo que já tem OS: o técnico escolhe registrar outra OS ou, se reprovou na quarentena, continuar com a mesma.
  const [newOs, setNewOs] = useState(false);
  const { asset, order, stages, requests, returns, canRedo, reload: reloadDevice } = useRepairDevice(client, serial, () =>
    toast("Não foi possível carregar o aparelho. Tente de novo."),
  );
  const [mineReloads, setMineReloads] = useState(0);
  const reload = useCallback(() => {
    reloadDevice();
    setMineReloads((n) => n + 1);
  }, [reloadDevice]);

  const fail = useCallback(
    (error: unknown, fallback = "Não foi possível concluir a operação. Tente de novo.") =>
      toast(describeRepairError(error as { code?: string; message?: string }, fallback)),
    [toast],
  );

  // O serial bipado só é consultado quando para de mudar.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSerial(typed.trim());
      setNewOs(false);
    }, LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    let active = true;
    fetchMyOpenStages(client, userId, ["desmontagem", "avaliacao"])
      .then((found) => active && setMine(found))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, userId, mineReloads]);

  const { disassembly, evaluation } = stages;
  // Um cronômetro por fase: o da avaliação liga sozinho quando a desmontagem termina.
  const onTimerError = (error: unknown) => fail(error, "Não foi possível atualizar o cronômetro.");
  const disassemblyTimer = useRepairTimer(client, disassembly?.id, onTimerError);
  const evaluationTimer = useRepairTimer(client, evaluation?.id, onTimerError);

  // "Faltando parafuso/blindagem": perguntas do Estágio 1, gravadas junto da desmontagem.
  const disassemblyRunningNow = disassembly?.status === "em_andamento";
  const missing = useRepairChecklists(client, disassembly?.id, disassemblyRunningNow, (error) => fail(error, "Não foi possível salvar as respostas."));
  const missingPending = missingPartsPending(missing.phases.aberto.results);

  const disassemblyRunning = disassembly?.status === "em_andamento";
  const evaluationRunning = evaluation?.status === "em_andamento";
  const active = disassemblyRunning ? "desmontagem" : evaluationRunning ? "avaliacao" : null;
  const openRequests = requests.filter((r) => isOpenRequest(r.status));
  // Só o trabalho em andamento aparece; o que já foi concluído não é mostrado de novo.
  const inProgress = disassemblyRunning || evaluationRunning;
  const finishedPass = Boolean(order && disassembly && !inProgress);
  const whereabouts = deviceWhereabouts({ evaluation: stages.evaluation, maintenance: stages.maintenance });

  // O pedido de peça pausa o cronômetro da fase em andamento: relê a lista e o cronômetro dela.
  const refreshDisassembly = disassemblyTimer.refresh;
  const refreshEvaluation = evaluationTimer.refresh;
  const afterRequestChange = useCallback(() => {
    reload();
    void refreshDisassembly();
    void refreshEvaluation();
  }, [reload, refreshDisassembly, refreshEvaluation]);

  const start = async () => {
    setBusy(true);
    try {
      const stageId = await startDisassembly(client, serial);
      await setTimer(client, stageId, "produtivo");
      toast("Desmontagem iniciada");
      reload();
    } catch (error) {
      fail(error, "Não foi possível iniciar a desmontagem.");
    } finally {
      setBusy(false);
    }
  };

  const confirmOpenRequests = (next: string) =>
    !openRequests.length ||
    window.confirm(`Há ${openRequests.length} solicitação(ões) de peça ainda em aberto. Elas seguem com o aparelho para ${next}. Concluir?`);

  const restart = async () => {
    if (!window.confirm("Reprovado na quarentena: iniciar uma nova desmontagem com a mesma OS? O histórico da rodada anterior continua guardado.")) return;
    setBusy(true);
    try {
      const stageId = await startDisassembly(client, serial);
      await setTimer(client, stageId, "produtivo");
      toast("Nova desmontagem iniciada na mesma OS");
      reload();
    } catch (error) {
      fail(error, "Não foi possível iniciar a nova desmontagem.");
    } finally {
      setBusy(false);
    }
  };

  const concludeDisassembly = async () => {
    if (!disassembly || !confirmOpenRequests("a avaliação técnica")) return;
    setBusy(true);
    try {
      await missing.flush();
      await finishDisassembly(client, disassembly.id);
      toast("Desmontagem concluída: avaliação técnica iniciada");
      reload();
    } catch (error) {
      fail(error, "Não foi possível concluir a desmontagem.");
    } finally {
      setBusy(false);
    }
  };

  const concludeEvaluation = async () => {
    if (!evaluation || !chosen || !glass) return;
    const label = STAGE1_DESTINATIONS.find((d) => d.id === chosen)?.label ?? chosen;
    const withGlass = glass === "vidro_mais";
    const confirmed = withGlass
      ? window.confirm(`Vidro e outra manutenção: pedir Vidro e Aro ao estoque e enviar o aparelho para: ${label}? Ao finalizar o Estágio 2, ele vai para o vidro.`)
      : chosen === "manutencao"
        ? confirmOpenRequests("o Estágio 2")
        : window.confirm(`Enviar o aparelho para: ${label}? Isso encerra o Estágio 1.`);
    if (!confirmed) return;
    setBusy(true);
    try {
      await finishEvaluation(client, evaluation.id, chosen, analysisNote, withGlass);
      toast(withGlass ? `Avaliação técnica concluída: ${label} (Vidro e Aro pedidos)` : `Avaliação técnica concluída: ${label}`);
      setDestination("manutencao");
      setGlass(null);
      setAnalysisNote("");
      reload();
    } catch (error) {
      fail(error, "Não foi possível concluir a avaliação técnica.");
    } finally {
      setBusy(false);
    }
  };

  const resume = (item: OpenStage) => {
    setTyped(item.serial);
    setSerial(item.serial);
    window.scrollTo(0, 0);
  };

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Reparo · Estágio 1</h1>
        <p className={appStyles.subtitle}>
          Bipe o serial, informe a OS e inicie a desmontagem. Ao concluir, a avaliação técnica começa a contar sozinha. Dá para concluir com
          pedidos de peça pendentes.
        </p>
      </header>

      <div className={styles.serial}>
        <label htmlFor="stage1-serial">Serial do aparelho</label>
        <input
          id="stage1-serial"
          value={typed}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Bipe ou digite o serial"
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>

      {mine.length > 0 && (
        <div className={styles.resume}>
          Em andamento:
          {mine.map((item) => (
            <Button key={item.id} variant="small" onClick={() => resume(item)}>
              {item.serial} · OS {item.osNumber} · {item.stage === "avaliacao" ? "avaliação técnica" : "desmontagem"}
            </Button>
          ))}
        </div>
      )}

      {serial && (
        <>
          <dl className={styles.info}>
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
              <dt>OS atual</dt>
              <dd>{order?.osNumber ?? "Sem OS"}</dd>
            </div>
          </dl>

          {!finishedPass && <OsField client={client} serial={serial} disabled={inProgress} onRegistered={reload} />}

          {!order && <p className={styles.hint}>Registre a OS para iniciar a desmontagem.</p>}

          {order && !disassembly && (
            <div className={styles.actions}>
              <Button disabled={busy} onClick={() => void start()}>
                Iniciar desmontagem
              </Button>
              <span className={styles.hint}>Cria a etapa desta OS e liga o cronômetro.</span>
            </div>
          )}

          {order && finishedPass && (
            <section className={styles.gate} aria-label="Este ativo já tem OS">
              <p className={styles.gateTitle}>
                Este ativo já tem a OS <strong>{order.osNumber}</strong> registrada
                {whereabouts ? ` e está ${whereabouts}` : ""}.
              </p>
              <div className={styles.gateOptions}>
                <div className={[styles.gateOption, canRedo ? styles.gateOptionOn : ""].join(" ")}>
                  <strong>Reprovado na quarentena</strong>
                  <span className={styles.hint}>
                    {canRedo
                      ? `A OS continua a mesma (${order.osNumber}): o ativo é desmontado de novo.`
                      : "Disponível só quando o ativo é reprovado na quarentena."}
                  </span>
                  <Button disabled={busy || !canRedo} onClick={() => void restart()}>
                    Continuar com a OS {order.osNumber}
                  </Button>
                </div>
                <div className={styles.gateOption}>
                  <strong>Outra OS</strong>
                  <span className={styles.hint}>Nova passagem do ativo pelo laboratório: registre o número da nova OS.</span>
                  {!newOs && (
                    <Button variant="ghost" disabled={busy} onClick={() => setNewOs(true)}>
                      Alterar a OS
                    </Button>
                  )}
                </div>
              </div>
              {newOs && <OsField client={client} serial={serial} onRegistered={reload} />}
            </section>
          )}

          {order && disassembly && inProgress && (
            <div className={styles.block}>
              <h2 className={styles.heading}>
                Desmontagem{disassembly.round > 1 ? ` · rodada ${disassembly.round} (reprovado na quarentena)` : ""}
              </h2>
              <RepairTimer
                title="Desmontagem"
                totals={disassemblyTimer.totals}
                action={disassemblyTimer.action}
                busy={disassemblyTimer.busy}
                disabled={!disassemblyRunning}
                onToggle={() => void disassemblyTimer.toggle()} onFinish={() => void disassemblyTimer.finish()}
              />
              <Checklist
                blocks={MISSING_PARTS_CATALOG}
                kind="desmontagem"
                results={missing.phases.aberto.results}
                onToggle={(sectionId, result) => missing.toggleResult("aberto", sectionId, result)}
                onToggleItem={() => undefined}
                onConfirm={() => undefined}
                disabled={!disassemblyRunning || !missing.loaded}
              />
              {disassemblyRunning && (
                <div className={styles.actions}>
                  <Button disabled={busy || !missing.loaded || missingPending > 0} onClick={() => void concludeDisassembly()}>
                    Concluir desmontagem
                  </Button>
                  <span className={styles.hint}>
                    {missingPending > 0
                      ? "Responda se o ativo veio faltando parafuso e blindagem para concluir."
                      : "A avaliação técnica começa a contar assim que a desmontagem terminar."}
                  </span>
                </div>
              )}

              <h2 className={styles.heading}>Avaliação técnica</h2>
              {evaluation ? (
                <>
                  <RepairTimer
                    title="Avaliação técnica"
                    totals={evaluationTimer.totals}
                    action={evaluationTimer.action}
                    busy={evaluationTimer.busy}
                    disabled={!evaluationRunning}
                    onToggle={() => void evaluationTimer.toggle()} onFinish={() => void evaluationTimer.finish()}
                  />
                  {evaluationRunning && (
                    <div className={styles.destinations}>
                      <ChoiceCards
                        name="stage1-glass"
                        legend="O aparelho é vidro?"
                        value={glass}
                        onChange={setGlass}
                        disabled={busy}
                        options={[
                          { id: "nao", label: GLASS_LABELS.nao, hint: "Segue o fluxo normal." },
                          { id: "so_vidro", label: GLASS_LABELS.so_vidro, hint: "Pede Vidro e Aro e vai direto para o Vidro (sem Estágio 2)." },
                          {
                            id: "vidro_mais",
                            label: GLASS_LABELS.vidro_mais,
                            hint: "Pede Vidro e Aro agora e vai para o Estágio 2. Ao finalizar a manutenção, vai para o vidro sem checklist.",
                          },
                        ]}
                      />
                      {glass && glass !== "so_vidro" && (
                        <ChoiceCards
                          name="stage1-destination"
                          legend="Para onde vai o aparelho?"
                          value={chosen}
                          onChange={setDestination}
                          disabled={busy}
                          options={STAGE1_DESTINATIONS.filter((option) => allowed.includes(option.id)).map((option) => {
                            const available = destinationAvailable(option.id, openRequests.length);
                            return { ...option, hint: available ? option.hint : "Só com solicitação de peça em aberto.", disabled: !available };
                          })}
                        />
                      )}
                      {chosen === "analise" && (
                        <label className={styles.noteField}>
                          Por que o aparelho vai para a Análise técnica? (obrigatório)
                          <textarea
                            value={analysisNote}
                            rows={3}
                            maxLength={1000}
                            disabled={busy}
                            placeholder="Descreva o defeito ou o motivo do envio"
                            onChange={(e) => setAnalysisNote(e.target.value)}
                          />
                        </label>
                      )}
                      <div className={styles.actions}>
                        <Button
                          disabled={busy || !glass || !chosen || noteMissing || !destinationAvailable(chosen, openRequests.length)}
                          onClick={() => void concludeEvaluation()}
                        >
                          Concluir avaliação técnica
                        </Button>
                        {!glass && <span className={styles.hint}>Responda se o aparelho é vidro.</span>}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className={styles.actions}>
                  <Button disabled>Avaliação técnica</Button>
                  <span className={styles.hint}>Começa a contar sozinha quando a desmontagem for concluída.</span>
                </div>
              )}

              {active && <PartRequestForm client={client} serial={serial} onSent={afterRequestChange} />}

              <h2 className={styles.heading}>Solicitações de peça da OS {order.osNumber}</h2>
              <RequestList client={client} requests={requests} returns={returns} disabled={busy} onChanged={afterRequestChange} />
            </div>
          )}
        </>
      )}
    </>
  );
}
