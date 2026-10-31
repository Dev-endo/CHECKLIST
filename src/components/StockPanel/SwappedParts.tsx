import { useEffect, useMemo, useState } from "react";
import { countSwaps, countSwapsByPerson, type SwappedPart } from "../../domain/stock";
import { fetchSwappedParts } from "../../services/supabase/analysisSearchService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import analysisStyles from "../AnalysisPanel/AnalysisPanel.module.css";
import styles from "./OverviewDialog.module.css";

const fmt = (n: number) => n.toLocaleString("pt-BR");

/** Peça e quantidade por modelo (sem a memória do aparelho). */
export function SwapTable({ counts }: { counts: ReturnType<typeof countSwaps> }) {
  return (
    <div className={analysisStyles.tableWrap}>
      <table className={analysisStyles.table}>
        <thead>
          <tr>
            <th>Peça</th>
            <th>Modelo</th>
            <th>Quantidade</th>
          </tr>
        </thead>
        <tbody>
          {counts.map((row) => (
            <tr key={`${row.part}-${row.model}`}>
              <td>{row.part}</td>
              <td>{row.model}</td>
              <td>{fmt(row.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Hoje, no formato do campo de data ("AAAA-MM-DD"), no fuso do navegador. */
export function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

interface SwappedPartsProps {
  client: AppSupabaseClient;
}

/**
 * Controle de perdas do estoquista: as peças trocadas no período (abre no dia de hoje), por erro técnico
 * (por técnico) e por qualidade do fornecedor, com peça e quantidade por modelo.
 */
export function SwappedParts({ client }: SwappedPartsProps) {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [swaps, setSwaps] = useState<SwappedPart[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setSwaps(null);
    setFailed(false);
    fetchSwappedParts(client, { from, to, userId: "" })
      .then((found) => active && setSwaps(found))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, from, to]);

  const technical = useMemo(() => (swaps ?? []).filter((swap) => swap.reason === "erro_tecnico"), [swaps]);
  const supplier = useMemo(() => (swaps ?? []).filter((swap) => swap.reason === "peca_ruim"), [swaps]);
  const byTechnician = useMemo(() => countSwapsByPerson(technical), [technical]);
  const supplierCounts = useMemo(() => countSwaps(supplier), [supplier]);

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
        <div className={styles.empty}>Não foi possível carregar as peças trocadas.</div>
      ) : !swaps ? (
        <div className={styles.empty}>Carregando…</div>
      ) : (
        <>
          <h3 className={analysisStyles.subtitle}>Trocadas por erro técnico · {fmt(technical.length)}</h3>
          {byTechnician.length === 0 ? (
            <div className={styles.empty}>Nenhuma peça trocada por erro técnico no período.</div>
          ) : (
            byTechnician.map((person) => (
              <div key={person.person}>
                <strong>
                  {person.person} · {fmt(person.total)} {person.total === 1 ? "peça" : "peças"}
                </strong>
                <SwapTable counts={person.counts} />
              </div>
            ))
          )}
          <h3 className={analysisStyles.subtitle}>Trocadas por qualidade do fornecedor · {fmt(supplier.length)}</h3>
          {supplierCounts.length === 0 ? (
            <div className={styles.empty}>Nenhuma peça trocada por qualidade do fornecedor no período.</div>
          ) : (
            <SwapTable counts={supplierCounts} />
          )}
        </>
      )}
    </>
  );
}
