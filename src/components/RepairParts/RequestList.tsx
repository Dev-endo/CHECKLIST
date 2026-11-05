import { useState } from "react";
import {
  CONDITION_LABELS,
  canCancelRequest,
  DESTINY_LABELS,
  describeRepairError,
  isOpenRequest,
  pendingBalance,
  PURPOSE_LABELS,
  REPLACE_FAILURE_LABELS,
  RETURN_REASON_LABELS,
  replaceableQty,
  STATUS_LABELS,
  type ReplaceFailure,
  type TestDestiny,
} from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { cancelRequest, type StockRequest } from "../../services/supabase/repairService";
import { defineTestDestiny, requestReplacement, type StockReturn } from "../../services/supabase/stockBoardService";
import { Button } from "../Button/Button";
import { useToast } from "../Toast/ToastProvider";
import styles from "./RepairParts.module.css";

interface RequestListProps {
  client: AppSupabaseClient;
  requests: StockRequest[];
  /** Devoluções da OS (de teste e de peças com defeito), para mostrar se o estoque já recebeu. */
  returns?: StockReturn[];
  disabled?: boolean;
  onChanged: () => void;
}

const STAGE_LABELS = { desmontagem: "Desmontagem", avaliacao: "Avaliação técnica", manutencao: "Estágio 2", analise: "Análise técnica" } as const;

type Action = { kind: "cancel"; id: string } | { kind: "replace"; id: string } | { kind: "return"; id: string } | null;

/**
 * Solicitações da OS com o status de cada uma. O técnico cancela (com justificativa) enquanto nada foi entregue,
 * define o destino da peça de teste entregue e pede a substituição de uma peça definitiva com defeito.
 */
export function RequestList({ client, requests, returns = [], disabled = false, onChanged }: RequestListProps) {
  const toast = useToast();
  const [action, setAction] = useState<Action>(null);
  const [reason, setReason] = useState("");
  const [replaceQty, setReplaceQty] = useState(1);
  const [failure, setFailure] = useState<ReplaceFailure | null>(null);
  const [replaceReason, setReplaceReason] = useState("");
  // Motivo da devolução da peça de teste (obrigatório).
  const [returnReason, setReturnReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (!requests.length) return <p className={styles.empty}>Nenhuma peça solicitada nesta OS.</p>;

  const run = async (task: () => Promise<unknown>, done: string, fallback: string) => {
    setBusy(true);
    try {
      await task();
      toast(done);
      setAction(null);
      setReason("");
      setReplaceQty(1);
      setFailure(null);
      setReplaceReason("");
      setReturnReason("");
      onChanged();
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, fallback));
    } finally {
      setBusy(false);
    }
  };

  const destiny = (id: string, value: TestDestiny, why?: string) =>
    run(
      () => defineTestDestiny(client, id, value, why),
      value === "devolucao" ? "Devolução solicitada: o estoque confirma o recebimento" : "Peça de teste mantida como definitiva",
      "Não foi possível definir o destino da peça.",
    );

  return (
    <ul className={styles.list}>
      {requests.map((r) => {
        const own = returns.filter((ret) => ret.requestId === r.id);
        const replaced = own.filter((ret) => ret.reason === "substituicao_defeito").reduce((sum, ret) => sum + ret.qty, 0);
        const canReplace = r.purpose === "definitiva" && replaceableQty(r.qtyDelivered, replaced) > 0;
        const needsDestiny = r.purpose === "teste" && r.status === "entregue" && !r.testDestiny;
        return (
          <li key={r.id} className={[styles.item, styles[`s_${r.status}`], needsDestiny ? styles.attention : ""].join(" ")}>
            <div className={styles.line}>
              <strong className={styles.part}>{r.part}</strong>
              <span className={styles.tag}>{PURPOSE_LABELS[r.purpose]}</span>
              {r.replacesRequestId && <span className={styles.tag}>Substituição</span>}
              {r.glass && <span className={styles.tag}>Para o vidro</span>}
              <span className={styles.qty}>
                {r.qtyDelivered}/{r.qty}
                {isOpenRequest(r.status) && r.qtyDelivered > 0 ? ` · faltam ${pendingBalance(r.qty, r.qtyDelivered)}` : ""}
              </span>
              <span className={styles.status}>{STATUS_LABELS[r.status]}</span>
              {r.originStage && <span className={styles.origin}>{STAGE_LABELS[r.originStage]}</span>}
              {canCancelRequest(r.status, r.qtyDelivered) && action?.id !== r.id && (
                <Button variant="small" disabled={disabled || busy} onClick={() => setAction({ kind: "cancel", id: r.id })}>
                  Cancelar
                </Button>
              )}
              {canReplace && action?.id !== r.id && (
                <Button variant="small" disabled={disabled || busy} onClick={() => setAction({ kind: "replace", id: r.id })}>
                  Peça com defeito: substituir
                </Button>
              )}
            </div>

            {r.replaceFailure && (
              <p className={styles.reason}>
                <strong>{REPLACE_FAILURE_LABELS[r.replaceFailure]}</strong>
                {r.replaceReason ? `: ${r.replaceReason}` : ""}
              </p>
            )}
            {r.status === "cancelada" && r.cancelReason && <p className={styles.reason}>Motivo: {r.cancelReason}</p>}
            {r.testDestiny && <p className={styles.reason}>Peça de teste: {DESTINY_LABELS[r.testDestiny]}.</p>}

            {needsDestiny && (
              <div className={styles.cancelBox}>
                <span className={styles.ask}>Peça de teste entregue. O que fazer com ela?</span>
                <Button disabled={disabled || busy} onClick={() => void destiny(r.id, "utilizacao_definitiva")}>
                  Utilizar definitivamente
                </Button>
                <Button variant="ghost" disabled={disabled || busy} onClick={() => setAction({ kind: "return", id: r.id })}>
                  Solicitar devolução
                </Button>
              </div>
            )}

            {action?.kind === "return" && action.id === r.id && (
              <div className={styles.replaceBox}>
                <textarea
                  className={styles.replaceReason}
                  value={returnReason}
                  rows={3}
                  maxLength={500}
                  autoFocus
                  placeholder="Por que está devolvendo a peça? (obrigatório)"
                  aria-label="Por que está devolvendo a peça"
                  onChange={(e) => setReturnReason(e.target.value)}
                />
                <div className={styles.cancelBox}>
                  <Button disabled={busy || returnReason.trim().length < 5} onClick={() => void destiny(r.id, "devolucao", returnReason)}>
                    Confirmar devolução
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setAction(null);
                      setReturnReason("");
                    }}
                  >
                    Voltar
                  </Button>
                </div>
              </div>
            )}

            {own.map((ret) => (
              <p key={ret.id} className={[styles.reason, ret.status === "aguardando_recebimento" ? styles.waiting : ""].join(" ")}>
                {RETURN_REASON_LABELS[ret.reason]} ({ret.qty}):{" "}
                {ret.status === "aguardando_recebimento"
                  ? "aguardando o estoque confirmar o recebimento"
                  : `recebida pelo estoque (${ret.condition ? CONDITION_LABELS[ret.condition] : "—"})`}
                {ret.note ? ` · Motivo: ${ret.note}` : ""}
              </p>
            ))}

            {action?.kind === "cancel" && action.id === r.id && (
              <div className={styles.cancelBox}>
                <input value={reason} maxLength={200} placeholder="Justificativa obrigatória" autoFocus onChange={(e) => setReason(e.target.value)} />
                <Button
                  variant="danger"
                  disabled={busy || reason.trim().length < 3}
                  onClick={() => void run(() => cancelRequest(client, r.id, reason.trim()), "Solicitação cancelada", "Não foi possível cancelar. Tente de novo.")}
                >
                  Confirmar cancelamento
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setAction(null)}>
                  Voltar
                </Button>
              </div>
            )}

            {action?.kind === "replace" && action.id === r.id && (
              <div className={styles.replaceBox}>
                <label className={styles.ask}>
                  Quantas vieram com defeito?{" "}
                  <input
                    type="number"
                    className={styles.qtyInput}
                    min={1}
                    max={replaceableQty(r.qtyDelivered, replaced)}
                    value={replaceQty}
                    onChange={(e) => setReplaceQty(Math.min(replaceableQty(r.qtyDelivered, replaced), Math.max(1, Number(e.target.value) || 1)))}
                  />
                </label>
                <div className={styles.failures} role="radiogroup" aria-label="Tipo de falha">
                  {(Object.keys(REPLACE_FAILURE_LABELS) as ReplaceFailure[]).map((value) => (
                    <label key={value} className={[styles.purpose, failure === value ? styles.purposeOn : ""].join(" ")}>
                      <input type="radio" name={`failure-${r.id}`} checked={failure === value} onChange={() => setFailure(value)} />
                      <span>{REPLACE_FAILURE_LABELS[value]}</span>
                    </label>
                  ))}
                </div>
                <textarea
                  className={styles.replaceReason}
                  value={replaceReason}
                  rows={3}
                  maxLength={500}
                  placeholder="Explique por que está substituindo a peça (obrigatório)"
                  aria-label="Por que está substituindo a peça"
                  onChange={(e) => setReplaceReason(e.target.value)}
                />
                <div className={styles.cancelBox}>
                  <Button
                    disabled={busy || !failure || replaceReason.trim().length < 5}
                    onClick={() =>
                      failure &&
                      void run(
                        () => requestReplacement(client, r.id, { qty: replaceQty, failure, reason: replaceReason }),
                        "Substituição solicitada: devolva a peça com defeito ao estoque",
                        "Não foi possível solicitar a substituição.",
                      )
                    }
                  >
                    Solicitar substituição
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setAction(null);
                      setFailure(null);
                      setReplaceReason("");
                    }}
                  >
                    Voltar
                  </Button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
