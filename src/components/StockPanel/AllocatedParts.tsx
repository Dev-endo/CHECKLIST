import { useEffect, useState } from "react";
import { ALLOCATION_LABELS } from "../../domain/stock";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchAllocationsInPeriod, type OpenAllocation } from "../../services/supabase/stockService";
import { formatDateTime } from "../../utils/format";
import styles from "./OverviewDialog.module.css";
import { today } from "./SwappedParts";

interface AllocatedPartsProps {
  client: AppSupabaseClient;
}

/** Peças alocadas por período: abre mostrando as do dia, e dá para trocar as datas. */
export function AllocatedParts({ client }: AllocatedPartsProps) {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [parts, setParts] = useState<OpenAllocation[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setParts(null);
    setFailed(false);
    fetchAllocationsInPeriod(client, from, to)
      .then((found) => active && setParts(found))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, from, to]);

  return (
    <>
      <div className={styles.filters}>
        <label>
          De
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Até
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {failed ? (
        <div className={styles.empty}>Não foi possível carregar as peças alocadas.</div>
      ) : !parts ? (
        <div className={styles.empty}>Carregando…</div>
      ) : parts.length === 0 ? (
        <div className={styles.empty}>Nenhuma peça alocada no período.</div>
      ) : (
        <>
          <div className={styles.empty}>
            {parts.length} {parts.length === 1 ? "peça alocada" : "peças alocadas"} no período.
          </div>
          <ul className={styles.list}>
            {parts.map((item) => (
              <li key={item.id}>
                <strong>{item.part}</strong>
                <span className={styles.meta}>
                  {item.model ?? "modelo não encontrado"} · OS {item.osNumber} · {item.allocatedBy} em {formatDateTime(item.createdAt)}
                </span>
                <span className={styles.status}>{ALLOCATION_LABELS[item.status]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
