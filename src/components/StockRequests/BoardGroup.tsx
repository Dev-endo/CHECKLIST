import { useState } from "react";
import {
  deliverableQty,
  describeRepairError,
  isOpenRequest,
  MOVEMENT_LABELS,
  PURPOSE_LABELS,
  STATUS_LABELS,
  type BoardGroup as Group,
} from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { cancelRequest } from "../../services/supabase/repairService";
import { deliverRequests, fetchMovements, setRequestStatus, type BoardRequest, type Movement } from "../../services/supabase/stockBoardService";
import { Button } from "../Button/Button";
import { useToast } from "../Toast/ToastProvider";
import styles from "./StockRequests.module.css";

interface BoardGroupProps {
  client: AppSupabaseClient;
  group: Group<BoardRequest>;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onChanged: () => void;
}

const STAGE_LABELS = { desmontagem: "Desmontagem", avaliacao: "Avaliação técnica", manutencao: "Estágio 2", analise: "Análise técnica" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Um aparelho (serial + OS) com as suas solicitações de peça. */
export function BoardGroup({ client, group, selected, onToggle, onChanged }: BoardGroupProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [history, setHistory] = useState<{ id: string; items: Movement[] } | null>(null);

  const first = group.requests[0];
  const requesters = [...new Set(group.requests.map((r) => r.requester))].join(", ");

  const run = async (task: () => Promise<unknown>, done: string, fallback: string) => {
    setBusy(true);
    try {
      await task();
      toast(done);
      onChanged();
      return true;
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const deliver = (r: BoardRequest) => {
    const qty = Math.min(deliverableQty(r.qty, r.qtyDelivered), Math.max(1, qtys[r.id] ?? deliverableQty(r.qty, r.qtyDelivered)));
    // A chave identifica este clique: se a resposta se perder e o botão for clicado de novo, o banco não entrega duas vezes.
    return run(() => deliverRequests(client, [{ id: r.id, qty }], crypto.randomUUID()), `${r.part}: ${qty} entregue(s)`, "Não foi possível confirmar a entrega.");
  };

  const toggleHistory = async (id: string) => {
    if (history?.id === id) {
      setHistory(null);
      return;
    }
    try {
      setHistory({ id, items: await fetchMovements(client, id) });
    } catch {
      toast("Não foi possível carregar o histórico.");
    }
  };

  return (
    <section className={styles.card} aria-label={`Aparelho ${group.serial}`}>
      <header className={styles.cardHead}>
        <strong className={styles.serial}>{group.serial}</strong>
        <span>{first?.model ?? "Modelo não encontrado"}</span>
        {first?.unit && <span className={styles.muted}>{first.unit}</span>}
        <span className={styles.os}>OS {group.osNumber}</span>
        <span className={styles.muted}>Técnico: {requesters}</span>
      </header>

      <ul className={styles.rows}>
        {group.requests.map((r) => {
          const open = isOpenRequest(r.status);
          const balance = deliverableQty(r.qty, r.qtyDelivered);
          return (
            <li key={r.id} className={[styles.row, styles[`s_${r.status}`]].join(" ")}>
              <div className={styles.line}>
                {open && (
                  <input
                    type="checkbox"
                    className={styles.check}
                    checked={selected.has(r.id)}
                    aria-label={`Selecionar ${r.part}`}
                    onChange={() => onToggle(r.id)}
                  />
                )}
                <strong className={styles.part}>{r.part}</strong>
                <span className={styles.tag}>{PURPOSE_LABELS[r.purpose]}</span>
                {r.replacesRequestId && <span className={styles.tag}>Substituição</span>}
                <span className={styles.qty}>
                  {r.qtyDelivered}/{r.qty}
                  {open && r.qtyDelivered > 0 ? ` · saldo ${balance}` : ""}
                </span>
                <span className={styles.status}>{STATUS_LABELS[r.status]}</span>
                <span className={styles.muted}>
                  {r.originStage ? `${STAGE_LABELS[r.originStage]} · ` : ""}
                  {when(r.createdAt)}
                </span>
              </div>

              <div className={styles.actions}>
                {open && (
                  <>
                    {r.status !== "em_separacao" && (
                      <Button variant="small" disabled={busy} onClick={() => void run(() => setRequestStatus(client, r.id, "em_separacao"), "Em separação", "Não foi possível atualizar.")}>
                        Separar
                      </Button>
                    )}
                    {r.status !== "sem_estoque" && (
                      <Button variant="small" disabled={busy} onClick={() => void run(() => setRequestStatus(client, r.id, "sem_estoque"), "Marcada sem estoque", "Não foi possível atualizar.")}>
                        Sem estoque
                      </Button>
                    )}
                    {r.qty > 1 && (
                      <input
                        type="number"
                        className={styles.qtyInput}
                        min={1}
                        max={balance}
                        value={qtys[r.id] ?? balance}
                        aria-label={`Quantidade a entregar de ${r.part}`}
                        onChange={(e) => setQtys((prev) => ({ ...prev, [r.id]: Math.min(balance, Math.max(1, Number(e.target.value) || 1)) }))}
                      />
                    )}
                    <Button disabled={busy} onClick={() => void deliver(r)}>
                      Confirmar entrega
                    </Button>
                    {r.part.trim().toLowerCase() === "aro" && r.qtyDelivered === 0 && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void run(() => cancelRequest(client, r.id, "Aro dispensado pelo estoque"), "Aro dispensado", "Não foi possível dispensar o aro.")}
                      >
                        Dispensar aro
                      </Button>
                    )}
                    {r.qtyDelivered === 0 && cancelling !== r.id && (
                      <Button variant="ghost" disabled={busy} onClick={() => setCancelling(r.id)}>
                        Cancelar
                      </Button>
                    )}
                  </>
                )}
                <Button variant="ghost" onClick={() => void toggleHistory(r.id)}>
                  {history?.id === r.id ? "Ocultar histórico" : "Histórico"}
                </Button>
              </div>

              {r.status === "cancelada" && r.cancelReason && <p className={styles.muted}>Motivo: {r.cancelReason}</p>}

              {cancelling === r.id && (
                <div className={styles.actions}>
                  <input value={reason} maxLength={200} placeholder="Justificativa obrigatória" autoFocus onChange={(e) => setReason(e.target.value)} />
                  <Button
                    variant="danger"
                    disabled={busy || reason.trim().length < 3}
                    onClick={() =>
                      void run(() => cancelRequest(client, r.id, reason.trim()), "Solicitação cancelada", "Não foi possível cancelar.").then((ok) => {
                        if (ok) {
                          setCancelling(null);
                          setReason("");
                        }
                      })
                    }
                  >
                    Confirmar cancelamento
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => setCancelling(null)}>
                    Voltar
                  </Button>
                </div>
              )}

              {history?.id === r.id && (
                <ol className={styles.history}>
                  {history.items.map((m) => (
                    <li key={m.id}>
                      <span className={styles.muted}>{when(m.createdAt)}</span> · {MOVEMENT_LABELS[m.kind] ?? m.kind}
                      {m.qty > 0 ? ` (${m.qty})` : ""} · {m.actor}
                      {typeof m.detail.motivo === "string" ? ` · ${m.detail.motivo}` : ""}
                      {typeof m.detail.condicao === "string" ? ` · ${m.detail.condicao}` : ""}
                    </li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
