import { useEffect, useRef, useState } from "react";
import { Button } from "../Button/Button";
import { FreshCard } from "./FreshCard";
import { RequestCard } from "./RequestCard";
import { useStockRequests } from "./StockRequests";
import styles from "./StockAlerts.module.css";

interface StockAlertsProps {
  /** Esconde os pedidos antigos (ex.: na aba Alocar peças, que já mostra a lista deles). */
  hideLegacy?: boolean;
  /** Esconde as solicitações novas e devoluções (ex.: na aba Solicitações de peça). */
  hideFresh?: boolean;
  /** Abre a aba Alocar peças, onde ficam os pedidos antigos. */
  onOpenStock: () => void;
  /** Abre a aba Solicitações de peça. */
  onOpenRequests: () => void;
}

/** Quantos avisos aparecem de uma vez; os outros ficam nas abas do Estoque. */
const MAX_SHOWN = 3;

/** Quanto tempo o aviso fica na tela antes de sumir sozinho. */
const VISIBLE_MS = 10_000;

/**
 * Aviso bem chamativo, em qualquer aba, para o estoquista: "<nome> solicitou <peça> para teste/manutenção" e
 * "<nome> devolveu <peça>". Some sozinho em 10 segundos ou no X; o pedido continua pendente na aba do Estoque.
 */
export function StockAlerts({ hideLegacy = false, hideFresh = false, onOpenStock, onOpenRequests }: StockAlertsProps) {
  const { items, fresh, busyId, decide } = useStockRequests();
  // Avisos já fechados (no X ou pelo tempo); um pedido novo volta a avisar.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const timed = useRef(new Set<string>());

  const freshVisible = hideFresh ? [] : fresh.filter((item) => !dismissed.has(item.id));
  const legacyVisible = hideLegacy ? [] : items.filter((item) => !dismissed.has(item.id));
  // As solicitações novas vêm primeiro: são o que o estoque precisa atender agora.
  const shown = [
    ...freshVisible.map((item) => ({ id: item.id, fresh: true as const, item })),
    ...legacyVisible.map((item) => ({ id: item.id, fresh: false as const, item })),
  ].slice(0, MAX_SHOWN);
  const total = freshVisible.length + legacyVisible.length;

  // Cada aviso novo conta 10 segundos a partir da hora em que passa a aparecer.
  const shownKey = shown.map((entry) => entry.id).join(",");
  useEffect(() => {
    const newOnes = shownKey ? shownKey.split(",").filter((id) => !timed.current.has(id)) : [];
    if (!newOnes.length) return;
    for (const id of newOnes) timed.current.add(id);
    const timer = setTimeout(() => setDismissed((prev) => new Set([...prev, ...newOnes])), VISIBLE_MS);
    return () => {
      // Se a lista mudar antes dos 10 segundos, os avisos voltam a contar na próxima rodada.
      clearTimeout(timer);
      for (const id of newOnes) timed.current.delete(id);
    };
  }, [shownKey]);

  if (!shown.length) return null;
  const rest = total - shown.length;
  const close = () => setDismissed((prev) => new Set([...prev, ...freshVisible.map((i) => i.id), ...legacyVisible.map((i) => i.id)]));

  return (
    <div className={styles.overlay} role="alert" aria-live="assertive">
      <button type="button" className={styles.close} onClick={close} aria-label="Fechar aviso">
        ×
      </button>
      {shown.map((entry) =>
        entry.fresh ? (
          <FreshCard key={entry.id} item={entry.item} />
        ) : (
          <RequestCard key={entry.id} item={entry.item} busy={busyId === entry.id} onDecide={(it, decision) => void decide(it, decision)} />
        ),
      )}
      <div className={styles.footer}>
        {rest > 0 && (
          <span className={styles.more}>
            +{rest} {rest === 1 ? "outro aviso" : "outros avisos"}
          </span>
        )}
        {freshVisible.length > 0 && (
          <Button variant="small" onClick={onOpenRequests}>
            Ver solicitações ({fresh.length})
          </Button>
        )}
        {legacyVisible.length > 0 && (
          <Button variant="small" onClick={onOpenStock}>
            Ver pedidos de alocação ({items.length})
          </Button>
        )}
      </div>
    </div>
  );
}
