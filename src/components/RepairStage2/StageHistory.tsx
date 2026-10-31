import { useEffect, useState } from "react";
import { describeMissingParts } from "../../domain/device";
import { fromSaved } from "../../domain/repairChecklist";
import { formatDuration, type TimerTotals } from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchChecklists, fetchTimer, type RepairStage } from "../../services/supabase/repairService";
import styles from "./RepairStage2.module.css";

interface StageHistoryProps {
  client: AppSupabaseClient;
  disassembly: RepairStage | null;
  evaluation: RepairStage | null;
}

const NAMES = { desmontagem: "Desmontagem", avaliacao: "Avaliação técnica", manutencao: "Manutenção" } as const;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "em andamento";

function Row({ stage, totals, note }: { stage: RepairStage; totals: TimerTotals | undefined; note?: string }) {
  return (
    <li className={styles.historyRow}>
      <strong>{NAMES[stage.stage]}</strong>
      <span className={styles.muted}>
        {when(stage.startedAt)} → {when(stage.finishedAt)}
      </span>
      {totals && (
        <span className={styles.times}>
          produtivo {formatDuration(totals.produtivo)} · pausas {formatDuration(totals.pausa)} · espera de peça {formatDuration(totals.espera_peca)}
        </span>
      )}
      {note && <span className={styles.times}>{note}</span>}
    </li>
  );
}

/** O que aconteceu antes da manutenção: desmontagem e avaliação técnica, com os tempos de cada uma. */
export function StageHistory({ client, disassembly, evaluation }: StageHistoryProps) {
  const [totals, setTotals] = useState<Record<string, TimerTotals>>({});
  // O que a desmontagem respondeu sobre parafuso e blindagem faltando.
  const [missingNote, setMissingNote] = useState<string | undefined>();
  const disassemblyId = disassembly?.id;
  const ids = [disassembly?.id, evaluation?.id].filter((id): id is string => Boolean(id));
  const key = ids.join(",");

  useEffect(() => {
    let active = true;
    Promise.all(ids.map(async (id) => [id, await fetchTimer(client, id)] as const))
      .then((entries) => active && setTotals(Object.fromEntries(entries)))
      .catch(() => undefined);
    return () => {
      active = false;
    };
    // `ids` é derivado de `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  useEffect(() => {
    setMissingNote(undefined);
    if (!disassemblyId) return;
    let active = true;
    fetchChecklists(client, disassemblyId)
      .then((saved) => active && setMissingNote(describeMissingParts(fromSaved(saved.aberto).results)))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, disassemblyId]);

  if (!disassembly && !evaluation) return <p className={styles.muted}>Sem registro de desmontagem nesta OS.</p>;
  return (
    <ul className={styles.history}>
      {disassembly && <Row stage={disassembly} totals={totals[disassembly.id]} note={missingNote} />}
      {evaluation && <Row stage={evaluation} totals={totals[evaluation.id]} />}
    </ul>
  );
}
