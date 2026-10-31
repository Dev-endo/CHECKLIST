import { useEffect, useMemo, useState } from "react";
import { countSwaps, countSwapsByPerson, type SwappedPart } from "../../domain/stock";
import { fetchSwappedParts } from "../../services/supabase/analysisSearchService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import type { MaintenanceReportFilters } from "../../services/supabase/reportService";
import analysisStyles from "../AnalysisPanel/AnalysisPanel.module.css";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import { OverviewDialog } from "../StockPanel/OverviewDialog";
import { SwapTable } from "../StockPanel/SwappedParts";
import overviewStyles from "../StockPanel/OverviewDialog.module.css";

interface PartsSearchViewProps {
  client: AppSupabaseClient;
  /** Período e colaborador escolhidos no topo da Análise. */
  filters: MaintenanceReportFilters;
  /** Muda a cada recarga automática da Análise. */
  reloads: number;
}

const fmt = (n: number) => n.toLocaleString("pt-BR");

/**
 * Peças trocadas pela decisão do estoquista: por erro técnico (por técnico) e por qualidade do fornecedor.
 * Cada caixa abre um balão com a peça e a quantidade por modelo (sem a memória do aparelho).
 */
export function PartsSearchView({ client, filters, reloads }: PartsSearchViewProps) {
  const [swaps, setSwaps] = useState<SwappedPart[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [balloon, setBalloon] = useState<"erro_tecnico" | "peca_ruim" | null>(null);

  useEffect(() => {
    let active = true;
    setFailed(false);
    fetchSwappedParts(client, filters)
      .then((found) => active && setSwaps(found))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, filters, reloads]);

  const technicalSwaps = useMemo(() => (swaps ?? []).filter((swap) => swap.reason === "erro_tecnico"), [swaps]);
  const supplierSwaps = useMemo(() => (swaps ?? []).filter((swap) => swap.reason === "peca_ruim"), [swaps]);
  const byTechnician = useMemo(() => countSwapsByPerson(technicalSwaps), [technicalSwaps]);
  const supplierCounts = useMemo(() => countSwaps(supplierSwaps), [supplierSwaps]);

  const total = (list: readonly SwappedPart[]) => (swaps ? fmt(list.length) : failed ? "—" : "…");

  return (
    <>
      <div className={analysisStyles.stats}>
        <button type="button" className={`${analysisStyles.stat} ${analysisStyles.statButton}`} onClick={() => setBalloon("erro_tecnico")}>
          <span className={analysisStyles.statValue}>{total(technicalSwaps)}</span>
          <span className={analysisStyles.statLabel}>Peças trocadas por erro técnico</span>
          <span className={analysisStyles.statHint}>clique para ver por técnico, peça e modelo</span>
        </button>
        <button type="button" className={`${analysisStyles.stat} ${analysisStyles.statButton}`} onClick={() => setBalloon("peca_ruim")}>
          <span className={analysisStyles.statValue}>{total(supplierSwaps)}</span>
          <span className={analysisStyles.statLabel}>Peças trocadas por qualidade do fornecedor</span>
          <span className={analysisStyles.statHint}>clique para ver por peça e modelo</span>
        </button>
      </div>
      {failed && <div className={recordStyles.empty}>Não foi possível carregar as trocas decididas pelo estoque.</div>}

      <OverviewDialog open={balloon === "erro_tecnico"} title="Peças trocadas por erro técnico" onClose={() => setBalloon(null)}>
        {byTechnician.length === 0 ? (
          <div className={overviewStyles.empty}>Nenhuma peça trocada por erro técnico neste período.</div>
        ) : (
          byTechnician.map((person) => (
            <div key={person.person}>
              <h3 className={analysisStyles.subtitle}>
                {person.person} · {fmt(person.total)} {person.total === 1 ? "peça" : "peças"}
              </h3>
              <SwapTable counts={person.counts} />
            </div>
          ))
        )}
      </OverviewDialog>
      <OverviewDialog open={balloon === "peca_ruim"} title="Peças trocadas por qualidade do fornecedor" onClose={() => setBalloon(null)}>
        {supplierCounts.length === 0 ? (
          <div className={overviewStyles.empty}>Nenhuma peça trocada por qualidade do fornecedor neste período.</div>
        ) : (
          <SwapTable counts={supplierCounts} />
        )}
      </OverviewDialog>
    </>
  );
}
