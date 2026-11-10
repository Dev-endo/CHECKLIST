import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MISSING_PARTS_CATALOG, missingPartsPending } from "../../domain/repairChecklist";
import { describeRepairError } from "../../domain/repairStages";
import { useRepairChecklists } from "../../hooks/useRepairChecklists";
import { useRepairDevice } from "../../hooks/useRepairDevice";
import { useRepairTimer } from "../../hooks/useRepairTimer";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { completeGlass, type GlassJob } from "../../services/supabase/glassService";
import {
  fetchMyOpenStages,
  fetchPersonName,
  finishGlassFlowDisassembly,
  startGlassFlow,
  type OpenStage,
  type RepairStage,
} from "../../services/supabase/repairService";
import { Button } from "../Button/Button";
import { Checklist } from "../Checklist/Checklist";
import { OsField } from "../DeviceForm/OsField";
import { RepairTimer } from "../RepairStage1/RepairTimer";
import { useToast } from "../Toast/ToastProvider";
import stage1Styles from "../RepairStage1/RepairStage1.module.css";
import styles from "./GlassPanel.module.css";

const LOOKUP_DEBOUNCE_MS = 400;

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
 * Aparelho que chega direto no vidro: bipa o serial, conclui o vidro (sem desmontagem nem estoque) e segue para o
 * checklist de display (o único do vidro): OK finaliza; falha ou display solicitado vai para o técnico escolhido.
 */
export function GlassDirect({ client, userId, isAdmin, technician, jobs, renderJob, reloadJobs }: GlassDirectProps) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [serial, setSerial] = useState("");
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
    }, LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  // O que está em andamento com este técnico: dá para retomar depois de recarregar a página.
  useEffect(() => {
    let active = true;
    fetchMyOpenStages(client, userId, ["desmontagem"])
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
  const disassemblyMine = Boolean(disassembly && disassembly.status === "em_andamento" && (disassembly.technicianId === userId || isAdmin));

  // De quem é a manutenção (o vidro não faz manutenção: o aparelho segue com o responsável ou com quem recebeu o display).
  const otherOwnerId = maintenance ? maintenance.technicianId : null;
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
    reloadAll();
  };

  // Vidro finalizado (entregue ao responsável ou display enviado): o aparelho sai da tela, sem abrir mais nenhuma escolha.
  const lastJob = useRef<GlassJob | null>(null);
  useEffect(() => {
    const previous = lastJob.current;
    lastJob.current = job;
    if (previous && !job && previous.serial === serial) clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  const start = async () => {
    if (!serial) return;
    setBusy(true);
    try {
      // O vidro não desmonta nem usa o estoque: abre o serviço e já conclui; falta o checklist de display.
      const jobId = await startGlassFlow(client, serial, false);
      await completeGlass(client, jobId);
      toast("Vidro concluído: responda o checklist de display");
      reloadAll();
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível começar o fluxo do vidro."));
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
              {item.serial} · OS {item.osNumber} · desmontagem
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

          {order && maintenance && !job && (
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
                  ? "Conclua o vidro e responda o checklist de display: tudo certo, finalize; display com falha (ou solicitado), escolha quem faz."
                  : "Conclua o vidro e responda o checklist de display: tudo certo, entregue a quem desmontou; display com falha (ou solicitado), escolha quem faz."}
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
              <div className={stage1Styles.actions}>
                <Button disabled={busy} onClick={() => void start()}>
                  Concluir vidro
                </Button>
                <span className={stage1Styles.hint}>Depois do vidro vem o checklist de display.</span>
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
