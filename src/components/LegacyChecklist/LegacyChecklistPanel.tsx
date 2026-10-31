import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import {
  choiceTests,
  expectedOutcome,
  finishBlockers,
  PHASE_KIND,
  PHASE_LABELS,
  phaseCatalog,
  PHASES,
  requiredTests,
  type FinishDestination,
} from "../../domain/repairChecklist";
import { describeRepairError } from "../../domain/repairStages";
import { useRepairChecklists } from "../../hooks/useRepairChecklists";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  fetchLastLegacy,
  fetchMyLegacyFinished,
  fetchMyOpenStages,
  finishMaintenance,
  startLegacyMaintenance,
  type LegacyChecklist,
  type OpenStage,
} from "../../services/supabase/repairService";
import { assetsBySerial } from "../../services/supabase/stockBoardService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import { Checklist } from "../Checklist/Checklist";
import { OsField } from "../DeviceForm/OsField";
import { FinishPanel } from "../RepairStage2/FinishPanel";
import { useToast } from "../Toast/ToastProvider";
import stage1Styles from "../RepairStage1/RepairStage1.module.css";
import stage2Styles from "../RepairStage2/RepairStage2.module.css";
import styles from "./LegacyChecklist.module.css";

const LOOKUP_DEBOUNCE_MS = 400;

const DESTINATIONS: readonly { id: FinishDestination; label: string; hint: string }[] = [
  { id: "auto", label: "Quarentena", hint: "Tudo aprovado. Com algum teste reprovado, o aparelho vai para a Análise técnica." },
  { id: "analise", label: "Análise técnica", hint: "Entra na fila da Análise técnica, mesmo sem teste reprovado." },
  { id: "vidro", label: "Vidro", hint: "Pede Vidro e Aro ao estoque e abre o serviço na aba Vidro; depois o checklist volta para você finalizar." },
];

const DESTINATION_LABELS = { quarentena: "Quarentena", analise: "Análise técnica", vidro: "Vidro", revenda: "Revenda" } as const;

const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const hour = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

/** Por que o checklist não abriu (sem OS o técnico registra ali mesmo). */
type Problem = { kind: "no_os" } | { kind: "message"; text: string } | null;

function problemFor(error: unknown): Problem {
  const text = (error as { message?: string })?.message ?? "";
  if (text.includes("no_os")) return { kind: "no_os" };
  if (text.includes("disassembly_open")) return { kind: "message", text: "Este aparelho está no Estágio 1 do Reparo: siga por lá." };
  if (text.includes("in_repair")) return { kind: "message", text: "Este aparelho está no Estágio 2 do Reparo: siga por lá." };
  if (text.includes("in_glass")) return { kind: "message", text: "Este aparelho está no Vidro. O checklist volta para quem o enviou quando o vidro terminar." };
  return { kind: "message", text: describeRepairError(error as { code?: string; message?: string }, "Não foi possível abrir o checklist. Tente de novo.") };
}

/** O checklist aberto para o serial bipado: novo ou retomado. */
interface Opened {
  serial: string;
  stageId: string;
  osNumber: string;
  /** Retomado (estava começado) ou novo; no novo, o último finalizado do aparelho, se houver. */
  resumed: boolean;
  previous: LegacyChecklist | null;
}

/**
 * Aba Checklist manutenção: os testes com o aparelho aberto e fechado ficam sempre na tela. O técnico bipa o serial
 * (modelo e Unit ID aparecem na hora); o que ele já tinha marcado é gravado no checklist do aparelho. Checklist
 * começado é retomado; aparelho já finalizado ganha um checklist novo. Ao finalizar: quarentena, análise técnica ou
 * vidro. No topo, quantos checklists o técnico finalizou hoje.
 */
export function LegacyChecklistPanel() {
  const { user, client } = useAuth();
  if (!client || !user) return <p className={appStyles.banner}>Entre com a sua conta para usar o Checklist manutenção.</p>;
  return <Legacy client={client} userId={user.id} technician={user.name || user.email} />;
}

function Legacy({ client, userId, technician }: { client: AppSupabaseClient; userId: string; technician: string }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [serial, setSerial] = useState("");
  const [asset, setAsset] = useState<{ model: string | null; unit: string } | null | undefined>(undefined);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [opening, setOpening] = useState(false);
  const [tries, setTries] = useState(0);
  const [destination, setDestination] = useState<FinishDestination>("auto");
  const [busy, setBusy] = useState(false);
  const [lastDone, setLastDone] = useState<{ serial: string; outcome: keyof typeof DESTINATION_LABELS } | null>(null);
  const [mine, setMine] = useState<OpenStage[]>([]);
  const [today, setToday] = useState<LegacyChecklist[] | null>(null);
  const [reloads, setReloads] = useState(0);
  const retry = useCallback(() => setTries((n) => n + 1), []);

  useEffect(() => {
    const timer = setTimeout(() => setSerial(typed.trim()), LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  // Bipou: modelo e Unit ID na hora.
  useEffect(() => {
    setAsset(undefined);
    if (!serial) return;
    let active = true;
    assetsBySerial(client, [serial])
      .then((found) => active && setAsset(found.get(serial.toLowerCase()) ?? null))
      .catch(() => active && setAsset(null));
    return () => {
      active = false;
    };
  }, [client, serial]);

  // Bipou: retoma o checklist começado ou abre um novo (o finalizado fica salvo no histórico).
  useEffect(() => {
    setOpened(null);
    setProblem(null);
    if (!serial) return;
    let active = true;
    setOpening(true);
    (async () => {
      const previous = await fetchLastLegacy(client, serial).catch(() => null);
      const stageId = await startLegacyMaintenance(client, serial);
      const current = await fetchLastLegacy(client, serial).catch(() => null);
      if (!active) return;
      const resumed = previous?.id === stageId && previous.status !== "concluida";
      setOpened({
        serial,
        stageId,
        osNumber: current?.id === stageId ? current.osNumber : "—",
        resumed,
        previous: previous?.status === "concluida" ? previous : null,
      });
    })()
      .catch((error) => active && setProblem(problemFor(error)))
      .finally(() => active && setOpening(false));
    return () => {
      active = false;
    };
  }, [client, serial, tries]);

  // Começados e não finalizados (para retomar) e os finalizados hoje (a contagem do dia).
  useEffect(() => {
    let active = true;
    fetchMyOpenStages(client, userId, ["manutencao"], ["em_andamento"], true)
      .then((found) => active && setMine(found))
      .catch(() => undefined);
    fetchMyLegacyFinished(client, userId, startOfToday())
      .then((found) => active && setToday(found))
      .catch(() => active && setToday((current) => current ?? []));
    return () => {
      active = false;
    };
  }, [client, userId, reloads, opened?.stageId]);

  const stageId = opened && opened.serial === serial ? opened.stageId : undefined;
  // Antes de bipar dá para marcar; se o serial não abre checklist (ex.: está no Reparo), fica travado.
  const editable = Boolean(stageId) || !(serial && problem?.kind === "message");
  const checklists = useRepairChecklists(client, stageId, editable && !busy, (error) => toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível salvar as marcações.")), true);

  const blockers = [
    ...(stageId ? [] : ["Bipe o serial do aparelho"]),
    ...finishBlockers({ results: checklists.results, requests: [], returnsWaiting: 0, destination, resaleReason: "" }),
  ];
  const outcome = expectedOutcome(checklists.results, destination);

  const clear = () => {
    setTyped("");
    setSerial("");
    setDestination("auto");
    input.current?.focus();
  };

  const finish = async () => {
    if (!stageId || busy) return;
    if (!window.confirm(`Finalizar o checklist de ${serial}? O aparelho vai para: ${DESTINATION_LABELS[outcome]}. Depois disso não dá para alterar.`)) return;
    setBusy(true);
    try {
      await checklists.flush();
      const result = await finishMaintenance(client, {
        stageId,
        requiredOpen: requiredTests("aberto"),
        requiredClosed: requiredTests("fechado"),
        choice: [...choiceTests("aberto"), ...choiceTests("fechado")],
        destination,
        resaleReason: "",
      });
      setLastDone({ serial, outcome: result });
      setReloads((n) => n + 1);
      clear();
      window.scrollTo(0, 0);
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível finalizar o checklist."));
    } finally {
      setBusy(false);
    }
  };

  const counts = { quarentena: 0, analise: 0, vidro: 0, revenda: 0 };
  for (const item of today ?? []) if (item.outcome) counts[item.outcome] += 1;
  const breakdown = (Object.keys(counts) as (keyof typeof counts)[])
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${DESTINATION_LABELS[key].toLowerCase()}`)
    .join(" · ");

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Checklist manutenção</h1>
        <p className={appStyles.subtitle}>
          Bipe o serial, faça os testes com o aparelho aberto e fechado e finalize: quarentena, análise técnica ou vidro.
        </p>
      </header>

      <section className={styles.today} aria-label="Seus checklists de hoje">
        <div className={styles.todayMain}>
          <span className={styles.todayLabel}>Você fez hoje</span>
          <strong className={styles.todayValue}>{today?.length ?? "…"}</strong>
          <span>{today?.length === 1 ? "checklist" : "checklists"}</span>
          {breakdown && <span className={styles.todayDetail}>{breakdown}</span>}
        </div>
        {today && today.length > 0 && (
          <details className={styles.todayList}>
            <summary>Ver os de hoje</summary>
            <ul>
              {today.map((item) => (
                <li key={item.id}>
                  <span className={styles.mono}>{item.serial}</span>
                  <span>{item.outcome ? DESTINATION_LABELS[item.outcome] : "—"}</span>
                  <span className={styles.muted}>{item.finishedAt ? hour(item.finishedAt) : ""}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {lastDone && !serial && (
        <p className={stage1Styles.done} role="status">
          Checklist de <strong>{lastDone.serial}</strong> finalizado. Destino: <strong>{DESTINATION_LABELS[lastDone.outcome]}</strong>. Bipe o
          próximo aparelho.
        </p>
      )}

      <div className={styles.top}>
        <div className={stage1Styles.serial}>
          <label htmlFor="legacy-serial">Serial do aparelho</label>
          <div className={styles.serialRow}>
            <input
              id="legacy-serial"
              ref={input}
              value={typed}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="Bipe ou digite o serial"
              disabled={busy}
              onChange={(e) => setTyped(e.target.value)}
            />
            {typed && (
              <Button variant="ghost" onClick={clear} disabled={busy}>
                Limpar
              </Button>
            )}
          </div>
        </div>

        <dl className={stage1Styles.info}>
          <div>
            <dt>Modelo</dt>
            <dd>{!serial ? "—" : asset === undefined ? "Buscando…" : asset?.model ?? "Serial fora da lista de ativos"}</dd>
          </div>
          <div>
            <dt>Unit ID</dt>
            <dd>{!serial || !asset ? "—" : asset.unit}</dd>
          </div>
          <div>
            <dt>OS</dt>
            <dd>{stageId && opened ? opened.osNumber : "—"}</dd>
          </div>
          <div>
            <dt>Técnico</dt>
            <dd>{technician}</dd>
          </div>
        </dl>
      </div>

      {serial && opening && <p className={stage1Styles.hint}>Abrindo o checklist…</p>}
      {stageId && opened && (
        <p className={stage1Styles.hint} role="status">
          {opened.resumed
            ? "Checklist retomado: as marcações já feitas neste aparelho estão abaixo."
            : opened.previous?.finishedAt
              ? `Checklist novo. O anterior deste aparelho foi finalizado em ${when(opened.previous.finishedAt)} (${
                  opened.previous.outcome ? DESTINATION_LABELS[opened.previous.outcome] : "—"
                }) e fica salvo no histórico.`
              : "Checklist novo."}
        </p>
      )}
      {serial && problem?.kind === "no_os" && (
        <>
          <p className={stage1Styles.hint}>Este aparelho não tem OS. Digite a OS e registre: o checklist abre em seguida.</p>
          <OsField client={client} serial={serial} onRegistered={retry} />
        </>
      )}
      {serial && problem?.kind === "message" && <p className={stage1Styles.hint}>{problem.text}</p>}

      {!serial && mine.length > 0 && (
        <div className={stage1Styles.resume}>
          Começados e não finalizados:
          {mine.map((item) => (
            <Button key={item.id} variant="small" onClick={() => setTyped(item.serial)}>
              {item.serial} · OS {item.osNumber}
            </Button>
          ))}
        </div>
      )}

      {PHASES.map((phase) => (
        <section key={phase} className={stage2Styles.phase} aria-label={PHASE_LABELS[phase]}>
          <h2 className={stage1Styles.heading}>{PHASE_LABELS[phase]}</h2>
          {!checklists.loaded ? (
            <p className={stage2Styles.muted}>Carregando…</p>
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
              disabled={!editable || busy}
            />
          )}
        </section>
      ))}

      <FinishPanel
        title="Finalizar checklist"
        blockers={blockers}
        outcome={outcome}
        destination={destination}
        resaleReason=""
        busy={busy}
        unsaved={Boolean(stageId) && checklists.unsaved}
        onDestination={setDestination}
        onReason={() => undefined}
        onFinish={() => void finish()}
        destinations={DESTINATIONS}
        hideCount
      />
    </>
  );
}
