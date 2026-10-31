import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CONDITION_LABELS,
  deliverableQty,
  describeRepairError,
  groupByDevice,
  isOpenRequest,
  RETURN_REASON_LABELS,
  type ReturnCondition,
} from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  confirmReturn,
  deliverRequests,
  fetchBoard,
  fetchBoardReturns,
  type BoardRequest,
  type BoardReturn,
} from "../../services/supabase/stockBoardService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import { useToast } from "../Toast/ToastProvider";
import { BoardGroup } from "./BoardGroup";
import styles from "./StockRequests.module.css";

const POLL_MS = 10_000;

type View = "abertas" | "devolucoes" | "historico";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

/** Estoque: solicitações de peça por aparelho, entregas (individual ou em lote), devoluções e peças segregadas. */
export function StockRequestsPanel({ client }: { client: AppSupabaseClient }) {
  const toast = useToast();
  const [view, setView] = useState<View>("abertas");
  const [board, setBoard] = useState<BoardRequest[]>([]);
  const [returns, setReturns] = useState<{ waiting: BoardReturn[]; segregated: BoardReturn[] }>({ waiting: [], segregated: [] });
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    const load = () =>
      Promise.all([fetchBoard(client), fetchBoardReturns(client)])
        .then(([requests, back]) => {
          if (!active) return;
          setBoard(requests);
          setReturns(back);
          setFailed(false);
          setLoaded(true);
          // Some da seleção o que já foi entregue ou cancelado por outra pessoa.
          const open = new Set(requests.filter((r) => isOpenRequest(r.status)).map((r) => r.id));
          setSelected((prev) => new Set([...prev].filter((id) => open.has(id))));
        })
        .catch(() => active && setFailed(true));
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, reloads]);

  const open = useMemo(() => board.filter((r) => isOpenRequest(r.status)), [board]);
  const closed = useMemo(() => board.filter((r) => !isOpenRequest(r.status)), [board]);
  const openGroups = useMemo(() => groupByDevice(open), [open]);
  const closedGroups = useMemo(() => groupByDevice(closed), [closed]);
  const counts = {
    pendente: open.filter((r) => r.status === "pendente").length,
    sem_estoque: open.filter((r) => r.status === "sem_estoque").length,
    devolucoes: returns.waiting.length,
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Entrega conjunta: o saldo inteiro de cada solicitação marcada, com um registro de entrega para cada uma.
  const deliverSelected = async () => {
    const items = open.filter((r) => selected.has(r.id)).map((r) => ({ id: r.id, qty: deliverableQty(r.qty, r.qtyDelivered) }));
    if (!items.length || busy) return;
    if (!window.confirm(`Confirmar a entrega física de ${items.length} solicitação(ões)?`)) return;
    setBusy(true);
    try {
      await deliverRequests(client, items, crypto.randomUUID());
      toast(`${items.length} entrega(s) confirmada(s)`);
      setSelected(new Set());
      reload();
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível confirmar as entregas."));
    } finally {
      setBusy(false);
    }
  };

  const receive = async (item: BoardReturn, condition: ReturnCondition) => {
    const note =
      condition === "funcional"
        ? "A peça volta ao estoque disponível."
        : "A peça fica segregada e NÃO volta ao estoque disponível.";
    if (!window.confirm(`Confirmar o recebimento físico de ${item.part} (${item.qty}) como "${CONDITION_LABELS[condition]}"? ${note}`)) return;
    setBusy(true);
    try {
      await confirmReturn(client, item.id, condition, crypto.randomUUID());
      toast("Recebimento confirmado");
      reload();
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível confirmar o recebimento."));
    } finally {
      setBusy(false);
    }
  };

  const tab = (id: View, label: string, count?: number, alert = false) => (
    <button key={id} type="button" className={styles.tab} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>
      {label}
      {count ? <span className={[styles.badge, alert ? styles.alert : ""].join(" ")}>{count}</span> : null}
    </button>
  );

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Estoque · solicitações de peça</h1>
        <p className={appStyles.subtitle}>
          Só o estoque confirma a entrega física e o recebimento das devoluções. Marque várias solicitações para entregar de uma vez.
        </p>
      </header>

      {failed && (
        <div className={appStyles.banner} role="alert">
          Não foi possível carregar as solicitações agora. Tentando de novo.
        </div>
      )}

      <nav className={styles.tabs} aria-label="Visões do estoque">
        {tab("abertas", "Em aberto", open.length)}
        {tab("devolucoes", "Devoluções", counts.devolucoes, counts.devolucoes > 0)}
        {tab("historico", "Histórico (7 dias)")}
      </nav>

      {view === "abertas" && (
        <>
          <p className={styles.summary}>
            <span>{counts.pendente} pendente(s)</span>
            <span className={counts.sem_estoque ? styles.alertText : ""}>{counts.sem_estoque} sem estoque</span>
            <span>{counts.devolucoes} devolução(ões) aguardando recebimento</span>
          </p>
          {!loaded && <p className={styles.muted}>Carregando…</p>}
          {loaded && !openGroups.length && <p className={styles.muted}>Nenhuma solicitação em aberto.</p>}
          {openGroups.map((group) => (
            <BoardGroup key={group.osId} client={client} group={group} selected={selected} onToggle={toggle} onChanged={reload} />
          ))}
          {selected.size > 0 && (
            <div className={styles.bar} role="region" aria-label="Entrega conjunta">
              <span>{selected.size} selecionada(s)</span>
              <Button variant="ghost" disabled={busy} onClick={() => setSelected(new Set())}>
                Limpar
              </Button>
              <Button disabled={busy} onClick={() => void deliverSelected()}>
                {busy ? "Confirmando…" : "Confirmar entrega das selecionadas"}
              </Button>
            </div>
          )}
        </>
      )}

      {view === "devolucoes" && (
        <>
          <h2 className={styles.heading}>Aguardando recebimento físico</h2>
          {!returns.waiting.length && <p className={styles.muted}>Nenhuma devolução aguardando.</p>}
          <ul className={styles.rows}>
            {returns.waiting.map((item) => (
              <li key={item.id} className={[styles.row, styles.s_sem_estoque].join(" ")}>
                <div className={styles.line}>
                  <strong className={styles.part}>{item.part}</strong>
                  <span className={styles.qty}>{item.qty}</span>
                  <span className={styles.tag}>{RETURN_REASON_LABELS[item.reason]}</span>
                  <span className={styles.muted}>
                    {item.serial} · OS {item.osNumber} · {item.model ?? "modelo não encontrado"} · {item.requester} · {when(item.requestedAt)}
                  </span>
                </div>
                <div className={styles.actions}>
                  <span className={styles.ask}>Condição da peça recebida:</span>
                  {(["funcional", "com_defeito", "necessita_avaliacao"] as const).map((condition) => (
                    <Button key={condition} variant={condition === "funcional" ? "primary" : "ghost"} disabled={busy} onClick={() => void receive(item, condition)}>
                      {CONDITION_LABELS[condition]}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>

          <h2 className={styles.heading}>Peças segregadas (fora do estoque disponível)</h2>
          {!returns.segregated.length && <p className={styles.muted}>Nenhuma peça segregada.</p>}
          <ul className={styles.rows}>
            {returns.segregated.map((item) => (
              <li key={item.id} className={styles.row}>
                <div className={styles.line}>
                  <strong className={styles.part}>{item.part}</strong>
                  <span className={styles.qty}>{item.qty}</span>
                  <span className={styles.tag}>{item.condition ? CONDITION_LABELS[item.condition] : "—"}</span>
                  <span className={styles.muted}>
                    {item.serial} · OS {item.osNumber} · {RETURN_REASON_LABELS[item.reason]} · recebida em {when(item.receivedAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {view === "historico" && (
        <>
          {loaded && !closedGroups.length && <p className={styles.muted}>Nada entregue ou cancelado nos últimos 7 dias.</p>}
          {closedGroups.map((group) => (
            <BoardGroup key={group.osId} client={client} group={group} selected={selected} onToggle={toggle} onChanged={reload} />
          ))}
        </>
      )}
    </>
  );
}
