import { useCallback, useEffect, useState, type ReactNode } from "react";
import { MISSING_PARTS_CATALOG, missingPartsPending } from "../../domain/repairChecklist";
import { describeRepairError } from "../../domain/repairStages";
import { useRepairChecklists } from "../../hooks/useRepairChecklists";
import { useRepairDevice } from "../../hooks/useRepairDevice";
import { useRepairTimer } from "../../hooks/useRepairTimer";
import type { AppSupabaseClient } from "../../services/supabase/client";
import type { GlassJob } from "../../services/supabase/glassService";
import {
  fetchMyOpenStages,
  fetchPersonName,
  finishGlassFlowDisassembly,
  setTimer,
  startGlassFlow,
  type OpenStage,
  type RepairStage,
} from "../../services/supabase/repairService";
import { Button } from "../Button/Button";
import { ChoiceCards } from "../ChoiceCards/ChoiceCards";
import { Checklist } from "../Checklist/Checklist";
import { OsField } from "../DeviceForm/OsField";
import { RepairTimer } from "../RepairStage1/RepairTimer";
import { Stage2Panel } from "../RepairStage2/Stage2Panel";
import { useToast } from "../Toast/ToastProvider";
import stage1Styles from "../RepairStage1/RepairStage1.module.css";
import styles from "./GlassPanel.module.css";

const LOOKUP_DEBOUNCE_MS = 400;

type Disassemble = "sim" | "nao";

interface GlassDirectProps {
  client: AppSupabaseClient;
  userId: string;
  isAdmin: boolean;
  technician: string;
  /** Serviços de vidro abertos (a lista da aba), para achar o do serial bipado. */
  jobs: GlassJob[] | null;
  /** Desenha o cartão do serviço de vidro (o mesmo da lista). */
  renderJob: (job: GlassJob) => ReactNode;
  /** Relê a lista de serviços de vidro da aba. */
  reloadJobs: () => void;
}

/**
 * Aparelho que chega direto no vidro: bipa o serial, responde se faz a desmontagem, faz o vidro e segue para o
 * checklist aberto, a montagem e o checklist fechado (a mesma tela do Estágio 2 do Reparo).
 */
export function GlassDirect({ client, userId, isAdmin, technician, jobs, renderJob, reloadJobs }: GlassDirectProps) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [serial, setSerial] = useState("");
  const [disassemble, setDisassemble] = useState<Disassemble | null>(null);
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<OpenStage[]>([]);
  const [mineReloads, setMineReloads] = useState(0);
  const [ownerName, setOwnerName] = useState<string | null>(null);

  const { asset, order, stages, reload: reloadDevice } = useRepairDevice(client, serial, () =>
    toast("Não foi possível carregar o aparelho. Tente de novo."),
  );
  const reloadAll = useCallback(() => {
    reloadDevice();
    reloadJobs();
    setMineReloads((n) => n + 1);
  }, [reloadDevice, reloadJobs]);

  // O serial bipado só é consultado quando para de mudar.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSerial(typed.trim());
      setDisassemble(null);
    }, LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  // O que está em andamento com este técnico: dá para retomar depois de recarregar a página.
  useEffect(() => {
    let active = true;
    fetchMyOpenStages(client, userId, ["desmontagem", "manutencao"])
      .then((found) => active && setMine(found))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, userId, mineReloads, jobs?.length]);

  const { disassembly, maintenance } = stages;
  const job = jobs?.find((item) => item.serial.trim().toLowerCase() === serial.toLowerCase()) ?? null;
  const hasProcess = Boolean(disassembly || maintenance || job);
  // Quando o serviço de vidro muda (ou sai da lista ao entregar), relê o aparelho: a manutenção abre sem esperar o ciclo.
  const jobStatus = job?.status ?? null;
  useEffect(() => {
    if (serial) reloadDevice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobStatus, serial]);
  const maintenanceMine = Boolean(maintenance && (maintenance.technicianId === userId || isAdmin));
  const disassemblyMine = Boolean(disassembly && disassembly.status === "em_andamento" && (disassembly.technicianId === userId || isAdmin));

  // De quem é a manutenção, quando não é deste técnico (ex.: foi direcionada para outro técnico).
  const otherOwnerId = maintenance && !maintenanceMine ? maintenance.technicianId : null;
  useEffect(() => {
    setOwnerName(null);
    if (!otherOwnerId) return;
    let active = true;
    fetchPersonName(client, otherOwnerId).then((name) => active && setOwnerName(name));
    return () => {
      active = false;
    };
  }, [client, otherOwnerId]);

  const clear = () => {
    setTyped("");
    setSerial("");
    setDisassemble(null);
    reloadAll();
  };

  const start = async () => {
    if (!disassemble || !serial) return;
    setBusy(true);
    try {
      const id = await startGlassFlow(client, serial, disassemble === "sim");
      if (disassemble === "sim") {
        await setTimer(client, id, "produtivo");
        toast("Desmontagem iniciada: Vidro e Aro já foram pedidos ao estoque");
      } else {
        toast("Serviço de vidro aberto: Vidro e Aro pedidos ao estoque");
      }
      reloadAll();
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível começar o fluxo do vidro."));
    } finally {
      setBusy(false);
    }
  };

  // Manutenção do próprio técnico: checklist aberto, montagem e checklist fechado (tela do Estágio 2).
  // Com um serviço de vidro ainda aberto, aparece o cartão do vidro (a manutenção anterior só fica finalizada).
  if (serial && order && maintenance && maintenanceMine && (!job || maintenance.status !== "concluida")) {
    return (
      <section className={styles.direct} aria-label="Checklist e montagem do vidro">
        <h2 className={stage1Styles.heading}>Vidro · checklist e montagem</h2>
        <Stage2Panel key={maintenance.id} initialSerial={serial} onBack={clear} hideHeader glass />
      </section>
    );
  }

  const resume = (item: OpenStage) => {
    setTyped(item.serial);
    setSerial(item.serial);
    window.scrollTo(0, 0);
  };

  return (
    <section className={styles.direct} aria-label="Receber aparelho no vidro">
      <h2 className={stage1Styles.heading}>Receber aparelho no vidro</h2>
      <div className={stage1Styles.serial}>
        <label htmlFor="glass-serial">Serial do aparelho</label>
        <input
          id="glass-serial"
          value={typed}
          autoComplete="off"
          spellCheck={false}
          placeholder="Bipe ou digite o serial"
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>

      {mine.length > 0 && (
        <div className={stage1Styles.resume}>
          Em andamento:
          {mine.map((item) => (
            <Button key={item.id} variant="small" onClick={() => resume(item)}>
              {item.serial} · OS {item.osNumber} · {item.stage === "manutencao" ? "checklist e montagem" : "desmontagem"}
            </Button>
          ))}
        </div>
      )}

      {serial && (
        <>
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
              <dt>OS atual</dt>
              <dd>{order?.osNumber ?? "Sem OS"}</dd>
            </div>
          </dl>

          {!hasProcess && <OsField client={client} serial={serial} onRegistered={reloadAll} />}
          {!order && <p className={stage1Styles.hint}>Registre a OS para continuar.</p>}

          {order && maintenance && !maintenanceMine && !job && (
            <p className={stage1Styles.hint} role="status">
              Este aparelho está na manutenção com <strong>{ownerName ?? "outro técnico"}</strong>
              {maintenance.status === "concluida" ? " (já finalizada)" : ""}.
            </p>
          )}

          {order && job && (
            <>
              {renderJob(job)}
              <p className={stage1Styles.hint}>
                {job.origin === "vidro"
                  ? "Conclua o vidro e siga para o checklist: ele abre aqui mesmo, com o checklist aberto, a montagem e o checklist fechado."
                  : "Conclua o vidro. Depois, “Fazer o checklist aqui” traz o checklist aberto (se não foi feito), a montagem e o checklist fechado; ou entregue ao responsável."}
              </p>
            </>
          )}

          {order && !maintenance && !job && disassembly && disassemblyMine && (
            <GlassDisassembly key={disassembly.id} client={client} stage={disassembly} onChanged={reloadAll} />
          )}

          {order && !maintenance && !job && disassembly && !disassemblyMine && (
            <p className={stage1Styles.hint} role="status">
              Este aparelho já tem etapas nesta OS e não está com você. Se ele voltou ao laboratório, registre uma OS nova.
            </p>
          )}

          {order && !hasProcess && (
            <div className={stage1Styles.destinations}>
              <ChoiceCards
                name="glass-disassemble"
                legend="Realizar desmontagem?"
                value={disassemble}
                onChange={setDisassemble}
                disabled={busy}
                options={[
                  {
                    id: "sim",
                    label: "Sim",
                    hint: "Mesmo processo de desmontagem do Reparo (cronômetro e perguntas). Vidro e Aro já são pedidos ao estoque.",
                  },
                  { id: "nao", label: "Não", hint: "Pula a desmontagem e vai direto para o reparo do vidro (pede Vidro e Aro)." },
                ]}
              />
              <div className={stage1Styles.actions}>
                <Button disabled={busy || !disassemble} onClick={() => void start()}>
                  {disassemble === "nao" ? "Ir para o vidro" : "Iniciar"}
                </Button>
                {!disassemble && <span className={stage1Styles.hint}>Responda se vai desmontar o aparelho.</span>}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Desmontagem do fluxo do vidro: o mesmo processo da desmontagem do Reparo (cronômetro e as duas perguntas). */
function GlassDisassembly({ client, stage, onChanged }: { client: AppSupabaseClient; stage: RepairStage; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const running = stage.status === "em_andamento";
  const fail = (error: unknown, fallback: string) => toast(describeRepairError(error as { code?: string; message?: string }, fallback));
  const timer = useRepairTimer(client, stage.id, (error) => fail(error, "Não foi possível atualizar o cronômetro."));
  const missing = useRepairChecklists(client, stage.id, running, (error) => fail(error, "Não foi possível salvar as respostas."));
  const pending = missingPartsPending(missing.phases.aberto.results);

  const conclude = async () => {
    setBusy(true);
    try {
      await missing.flush();
      await finishGlassFlowDisassembly(client, stage.id);
      toast("Desmontagem concluída: o serviço de vidro foi aberto");
      onChanged();
    } catch (error) {
      fail(error, "Não foi possível concluir a desmontagem.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={stage1Styles.block}>
      <h2 className={stage1Styles.heading}>Desmontagem</h2>
      <RepairTimer
        title="Desmontagem"
        totals={timer.totals}
        action={timer.action}
        busy={timer.busy}
        disabled={!running}
        onToggle={() => void timer.toggle()}
        onFinish={() => void timer.finish()}
      />
      <Checklist
        blocks={MISSING_PARTS_CATALOG}
        kind="desmontagem"
        results={missing.phases.aberto.results}
        onToggle={(sectionId, result) => missing.toggleResult("aberto", sectionId, result)}
        onToggleItem={() => undefined}
        onConfirm={() => undefined}
        disabled={!running || !missing.loaded}
      />
      {running && (
        <div className={stage1Styles.actions}>
          <Button disabled={busy || !missing.loaded || pending > 0} onClick={() => void conclude()}>
            Concluir desmontagem
          </Button>
          <span className={stage1Styles.hint}>
            {pending > 0
              ? "Responda se o ativo veio faltando parafuso e blindagem para concluir."
              : "Ao concluir, o serviço de vidro abre (sem avaliação técnica)."}
          </span>
        </div>
      )}
    </div>
  );
}
