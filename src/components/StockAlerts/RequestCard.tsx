import { requestMessage, SWAP_DECISIONS } from "../../domain/stock";
import type { PendingRequest } from "../../services/supabase/stockService";
import { Button } from "../Button/Button";
import styles from "./StockAlerts.module.css";

type Decision = "recusar" | "atender" | (typeof SWAP_DECISIONS)[number]["id"];

const ATTEND_LABELS = {
  nova: "Alocar peça",
  teste: "Emprestar peça",
  uso: "Liberar para uso",
  devolucao: "Confirmar devolução",
} as const;

interface RequestCardProps {
  item: PendingRequest;
  busy: boolean;
  onDecide: (item: PendingRequest, decision: Decision) => void;
  /** Na lista da aba Estoque o cartão não pulsa. */
  flat?: boolean;
}

/** Um pedido de peça com as decisões do estoquista. */
export function RequestCard({ item, busy, onDecide, flat = false }: RequestCardProps) {
  return (
    <div className={[styles.card, flat ? styles.flat : ""].join(" ")}>
      <div className={styles.message}>{requestMessage(item.requester, item.kind)}</div>
      <div className={styles.detail}>
        {item.part} · {item.model ?? "modelo não encontrado"} · OS {item.osNumber}
      </div>
      <div className={styles.actions}>
        {item.kind !== "troca" && (
          <Button disabled={busy} onClick={() => onDecide(item, "atender")}>
            {ATTEND_LABELS[item.kind]}
          </Button>
        )}
        {item.kind === "troca" &&
          SWAP_DECISIONS.map(({ id, label }) => (
            <Button key={id} disabled={busy} onClick={() => onDecide(item, id)}>
              {label}
            </Button>
          ))}
        <Button variant="ghost" disabled={busy} onClick={() => onDecide(item, "recusar")}>
          Recusar
        </Button>
      </div>
      {item.kind === "troca" && (
        <div className={styles.hint}>Decida se a peça estava ruim ou se foi erro do técnico. Uma nova peça é alocada.</div>
      )}
      {item.kind === "teste" && <div className={styles.hint}>Emprestada, a peça precisa voltar ao estoque. Acompanhe na aba Peças emprestadas.</div>}
      {item.kind === "uso" && <div className={styles.hint}>Ao liberar, a peça passa a ser do aparelho e o técnico pode concluir.</div>}
    </div>
  );
}
