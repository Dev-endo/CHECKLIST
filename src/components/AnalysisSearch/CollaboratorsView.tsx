import { useEffect, useMemo, useState } from "react";
import { fetchCollaboratorSummary, type CollaboratorSummary } from "../../services/supabase/analysisSearchService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import type { MaintenanceReportFilters } from "../../services/supabase/reportService";
import { AnalysisDevicesDialog } from "../AnalysisDevicesDialog/AnalysisDevicesDialog";
import analysisStyles from "../AnalysisPanel/AnalysisPanel.module.css";
import reviewStyles from "../ReviewPanel/ReviewPanel.module.css";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";

interface CollaboratorsViewProps {
  client: AppSupabaseClient;
  /** Período escolhido no topo da Análise (o colaborador é escolhido aqui). */
  filters: MaintenanceReportFilters;
  reloads: number;
}

const fmt = (n: number) => n.toLocaleString("pt-BR");
const total = (row: CollaboratorSummary) =>
  row.maintenance + row.disassembly + row.technical + row.assembly + row.quarantine;

/** Pesquisa por colaborador: o que cada pessoa concluiu em cada etapa; clicar abre os aparelhos dela. */
export function CollaboratorsView({ client, filters, reloads }: CollaboratorsViewProps) {
  const [rows, setRows] = useState<CollaboratorSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<CollaboratorSummary | null>(null);

  useEffect(() => {
    let active = true;
    setFailed(false);
    fetchCollaboratorSummary(client, filters)
      .then((found) => active && setRows(found))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, filters.from, filters.to, reloads]);

  const query = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (rows ?? [])
        // O colaborador escolhido no topo da Análise vale aqui também.
        .filter((row) => !filters.userId || row.userId === filters.userId)
        .filter((row) => !query || row.name.toLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" })),
    [rows, query, filters.userId],
  );
  const sum = (pick: (row: CollaboratorSummary) => number) => shown.reduce((n, row) => n + pick(row), 0);

  return (
    <>
      <div className={reviewStyles.filters}>
        <label className={reviewStyles.field}>
          Colaborador
          <input value={search} placeholder="Pesquisar pelo nome" onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>

      {failed && <div className={recordStyles.empty}>Não foi possível carregar a pesquisa.</div>}
      {!failed && !rows && <div className={recordStyles.empty}>Carregando…</div>}
      {rows && !shown.length && <div className={recordStyles.empty}>Nenhum colaborador com checklists neste período.</div>}
      {shown.length > 0 && (
        <>
          <p className={analysisStyles.statHint} style={{ padding: "8px 14px 0" }}>
            Checklists concluídos no período. "Manutenções feitas" soma os itens trocados (o mesmo número do card da aba Manutenções); cada checklist pode ter vários itens. Clique em um colaborador para ver os aparelhos, o destino e as observações.
          </p>
          <div className={analysisStyles.tableWrap}>
            <table className={analysisStyles.table}>
              <thead>
                <tr>
                  <th>Colaborador</th>
                  <th>Checklists de manutenção</th>
                  <th>Manutenções feitas</th>
                  <th>Desmontagem</th>
                  <th>Desm. técnica</th>
                  <th>Montagem</th>
                  <th>Quarentena</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.userId}>
                    <td>
                      <button type="button" className={analysisStyles.linkButton} onClick={() => setPicked(row)}>
                        {row.name}
                      </button>
                    </td>
                    <td>{fmt(row.maintenance)}</td>
                    <td>{fmt(row.maintenanceItems)}</td>
                    <td>{fmt(row.disassembly)}</td>
                    <td>{fmt(row.technical)}</td>
                    <td>{fmt(row.assembly)}</td>
                    <td>{fmt(row.quarantine)}</td>
                    <td>{fmt(total(row))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td>{fmt(sum((r) => r.maintenance))}</td>
                  <td>{fmt(sum((r) => r.maintenanceItems))}</td>
                  <td>{fmt(sum((r) => r.disassembly))}</td>
                  <td>{fmt(sum((r) => r.technical))}</td>
                  <td>{fmt(sum((r) => r.assembly))}</td>
                  <td>{fmt(sum((r) => r.quarantine))}</td>
                  <td>{fmt(sum(total))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      <AnalysisDevicesDialog
        client={client}
        detail={picked ? { metric: "all_stages", label: `Aparelhos de ${picked.name}` } : null}
        filters={{ ...filters, userId: picked?.userId ?? "" }}
        onClose={() => setPicked(null)}
      />
    </>
  );
}
