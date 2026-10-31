import { useCallback, useEffect, useRef, useState } from "react";
import { describeRepairError } from "../../domain/repairStages";
import { STOCK_PARTS } from "../../domain/stock";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchAnalysisParts, requestAnalysisTestPart } from "../../services/supabase/analysisTechService";
import type { StockRequest } from "../../services/supabase/repairService";
import type { StockReturn } from "../../services/supabase/stockBoardService";
import { Button } from "../Button/Button";
import { RequestList } from "../RepairParts/RequestList";
import { useToast } from "../Toast/ToastProvider";
import styles from "./AnalysisTechPanel.module.css";

const POLL_MS = 10_000;

interface AnalysisPartsProps {
  client: AppSupabaseClient;
  analysisId: string;
  /** Início do ciclo da análise: só as peças pedidas desde então. */
  startedAt: string;
  canAct: boolean;
  /** Avisa o cartão das peças atuais (para travar o fim da análise e mostrar a peça definitiva). */
  onChange: (requests: StockRequest[]) => void;
  /** Pedir peça pausa o cronômetro da análise: o cartão relê o cronômetro. */
  onRequested: () => void;
}

/**
 * Peças de teste da análise: o analista pede uma por vez (uma de cada tipo), o estoque entrega e ele decide:
 * devolver ao estoque ou usar como definitiva (a peça vai junto com o aparelho para o Estágio 2).
 */
export function AnalysisParts({ client, analysisId, startedAt, canAct, onChange, onRequested }: AnalysisPartsProps) {
  const toast = useToast();
  const [requests, setRequests] = useState<StockRequest[]>([]);
  const [returns, setReturns] = useState<StockReturn[]>([]);
  const [part, setPart] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  // O cartão passa uma função nova a cada render: guardada aqui para não recarregar a lista sem parar.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchAnalysisParts(client, analysisId, startedAt)
        .then(({ requests: found, returns: back }) => {
          if (!active) return;
          setRequests(found);
          setReturns(back);
          onChangeRef.current(found);
        })
        .catch(() => undefined);
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, analysisId, startedAt, reloads]);

  const ask = async () => {
    if (!part || busy) return;
    setBusy(true);
    try {
      await requestAnalysisTestPart(client, analysisId, part);
      toast(`${part} pedida para teste`);
      setPart("");
      reload();
      onRequested();
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível pedir a peça."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.parts} aria-label="Peças de teste da análise">
      <h3 className={styles.partsTitle}>Peças de teste da análise</h3>
      {canAct && (
        <div className={styles.partsForm}>
          <select value={part} disabled={busy} aria-label="Peça para teste" onChange={(e) => setPart(e.target.value)}>
            <option value="">Escolha a peça…</option>
            {STOCK_PARTS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <Button variant="small" disabled={busy || !part} onClick={() => void ask()}>
            {busy ? "Pedindo…" : "Pedir peça para teste"}
          </Button>
          <span className={styles.muted}>Uma unidade de cada tipo. O cronômetro pausa até você retomar.</span>
        </div>
      )}
      {requests.length > 0 ? (
        <RequestList client={client} requests={requests} returns={returns} disabled={!canAct} onChanged={reload} />
      ) : (
        <p className={styles.muted}>Nenhuma peça pedida para teste nesta análise.</p>
      )}
    </section>
  );
}
