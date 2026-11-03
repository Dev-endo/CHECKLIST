import { useCallback, useEffect, useState } from "react";
import { describeRepairError } from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { decidePt, fetchPtRequests, type PtRequest } from "../../services/supabase/ptService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import { useToast } from "../Toast/ToastProvider";
import styles from "./PtApproval.module.css";

const POLL_MS = 30_000;
const HISTORY_DAYS = 7;

const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * Aba Aprovação PT (administradores e supervisores): os pedidos de perda total esperando decisão. Aprovar fecha o
 * aparelho como PT; reprovar (com comentário) devolve a manutenção para o técnico escolher outro destino.
 */
export function PtApprovalPanel({ client }: { client: AppSupabaseClient }) {
  const toast = useToast();
  const [pending, setPending] = useState<PtRequest[] | null>(null);
  const [decided, setDecided] = useState<PtRequest[]>([]);
  const [reloads, setReloads] = useState(0);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () => {
      const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000);
      fetchPtRequests(client, since)
        .then((found) => {
          if (!active) return;
          setPending(found.pending);
          setDecided(found.decided);
        })
        .catch(() => active && setPending((current) => current ?? []));
    };
    load();
    const poll = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, reloads]);

  const decide = useCallback(
    async (item: PtRequest, approve: boolean) => {
      if (approve && !window.confirm(`Aprovar o PT de ${item.serial}? O aparelho fecha como perda total.`)) return;
      setBusy(true);
      try {
        await decidePt(client, item.id, approve, approve ? "" : note);
        toast(approve ? `PT de ${item.serial} aprovado` : `PT de ${item.serial} reprovado: voltou para ${item.requestedBy}`);
        setRejecting(null);
        setNote("");
        setReloads((n) => n + 1);
      } catch (error) {
        toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível registrar a decisão. Tente de novo."));
      } finally {
        setBusy(false);
      }
    },
    [client, note, toast],
  );

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Aprovação PT</h1>
        <p className={appStyles.subtitle}>
          Pedidos de perda total dos técnicos. Aprovado, o aparelho fecha como PT. Reprovado, volta para o técnico com o seu comentário.
        </p>
      </header>

      <h2 className={styles.heading}>Aguardando aprovação {pending ? `(${pending.length})` : ""}</h2>
      {pending === null && <p className={styles.muted}>Carregando…</p>}
      {pending?.length === 0 && <p className={styles.muted}>Nenhum PT aguardando aprovação.</p>}
      <ul className={styles.list}>
        {pending?.map((item) => (
          <li key={item.id} className={styles.item}>
            <div className={styles.line}>
              <strong className={styles.serial}>{item.serial}</strong>
              <span>{item.model ?? "Modelo não encontrado"}</span>
              {item.unit && <span className={styles.muted}>{item.unit}</span>}
              <span className={styles.muted}>OS {item.osNumber}</span>
              <span className={styles.tag}>{item.legacy ? "Checklist manutenção" : "Reparo"}</span>
            </div>
            <p className={styles.meta}>
              Pedido por <strong>{item.requestedBy}</strong> em {when(item.requestedAt)}
            </p>
            <p className={styles.reason}>
              <strong>Motivo:</strong> {item.reason}
            </p>

            {rejecting === item.id ? (
              <div className={styles.reject}>
                <textarea
                  value={note}
                  rows={3}
                  maxLength={1000}
                  autoFocus
                  placeholder="Comentário para o técnico (obrigatório): por que não é PT?"
                  aria-label="Comentário da reprovação"
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className={styles.actions}>
                  <Button variant="danger" disabled={busy || note.trim().length < 5} onClick={() => void decide(item, false)}>
                    Confirmar reprovação
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setRejecting(null);
                      setNote("");
                    }}
                  >
                    Voltar
                  </Button>
                </div>
              </div>
            ) : (
              <div className={styles.actions}>
                <Button disabled={busy} onClick={() => void decide(item, true)}>
                  Aprovar PT
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setRejecting(item.id);
                    setNote("");
                  }}
                >
                  Reprovar
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <h2 className={styles.heading}>Decididos nos últimos {HISTORY_DAYS} dias</h2>
      {decided.length === 0 ? (
        <p className={styles.muted}>Nenhuma decisão no período.</p>
      ) : (
        <ul className={styles.list}>
          {decided.map((item) => (
            <li key={item.id} className={[styles.item, item.status === "aprovado" ? styles.approved : styles.rejectedItem].join(" ")}>
              <div className={styles.line}>
                <strong className={styles.serial}>{item.serial}</strong>
                <span>{item.model ?? "Modelo não encontrado"}</span>
                <span className={styles.tag}>{item.status === "aprovado" ? "Aprovado" : "Reprovado"}</span>
                <span className={styles.muted}>
                  {item.decidedBy} · {item.decidedAt ? when(item.decidedAt) : ""}
                </span>
              </div>
              <p className={styles.reason}>
                <strong>Motivo:</strong> {item.reason} · pedido por {item.requestedBy}
              </p>
              {item.decisionNote && (
                <p className={styles.reason}>
                  <strong>Comentário:</strong> {item.decisionNote}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
