import { alertMessage, RETURN_REASON_LABELS } from "../../domain/repairStages";
import type { AlertItem } from "../../services/supabase/stockBoardService";
import styles from "./StockAlerts.module.css";

/** Aviso de uma solicitação nova ou de uma devolução esperando o estoque. A decisão é na aba Solicitações. */
export function FreshCard({ item }: { item: AlertItem }) {
  return (
    <div className={styles.card}>
      <div className={styles.message}>{alertMessage(item)}</div>
      <div className={styles.detail}>
        Serial {item.serial} · OS {item.osNumber}
        {item.reason ? ` · ${RETURN_REASON_LABELS[item.reason]}` : ""}
      </div>
    </div>
  );
}
