import { useEffect, useState } from "react";
import { splitAssetId } from "../../domain/device";
import type { AppSupabaseClient } from "../../services/supabase/client";
import type { MaintenanceReportFilters } from "../../services/supabase/reportService";
import { searchServiceOrders, type ServiceOrder } from "../../services/supabase/serviceOrderService";
import { formatDateTime } from "../../utils/format";
import analysisStyles from "../AnalysisPanel/AnalysisPanel.module.css";
import { OsMapDialog } from "../OsMapDialog/OsMapDialog";
import reviewStyles from "../ReviewPanel/ReviewPanel.module.css";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";

interface OsSearchViewProps {
  client: AppSupabaseClient;
  /** Período escolhido no topo da Análise (pela data de registro da OS). */
  filters: MaintenanceReportFilters;
  reloads: number;
}

const DEBOUNCE_MS = 300;

/** Pesquisa de OS por número, serial ou unit id; clicar em uma OS abre o mapa dela. */
export function OsSearchView({ client, filters, reloads }: OsSearchViewProps) {
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<ServiceOrder[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setTerm(input), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    let active = true;
    setFailed(false);
    searchServiceOrders(client, term, filters)
      .then((found) => active && setRows(found))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, term, filters.from, filters.to, reloads]);

  // Quantas OS cada ativo tem na lista (o mapa mostra o total geral do ativo).
  const perAsset = new Map<string, number>();
  for (const row of rows ?? []) {
    const key = row.serial.trim().toLowerCase();
    perAsset.set(key, (perAsset.get(key) ?? 0) + 1);
  }

  return (
    <>
      <div className={reviewStyles.filters}>
        <label className={reviewStyles.field}>
          Número da OS, serial ou unit ID
          <input value={input} placeholder="Pesquisar" onChange={(e) => setInput(e.target.value)} />
        </label>
      </div>

      {failed && <div className={recordStyles.empty}>Não foi possível carregar as OS.</div>}
      {!failed && !rows && <div className={recordStyles.empty}>Carregando…</div>}
      {rows && !rows.length && <div className={recordStyles.empty}>Nenhuma OS encontrada neste período.</div>}
      {rows && rows.length > 0 && (
        <>
          <p className={analysisStyles.statHint} style={{ padding: "8px 14px 0" }}>
            {rows.length} OS registradas no período. Clique em uma OS para ver o mapa dela: datas, quem fez cada etapa e
            as reprovações.
          </p>
          <div className={analysisStyles.tableWrap}>
            <table className={`${analysisStyles.table} ${analysisStyles.listTable}`}>
              <thead>
                <tr>
                  <th>OS</th>
                  <th>Unit ID</th>
                  <th>Modelo</th>
                  <th>Serial</th>
                  <th>Registrada em</th>
                  <th>Por</th>
                  <th>OS do ativo no período</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const asset = row.unit ? splitAssetId(row.unit) : null;
                  return (
                    <tr key={row.id}>
                      <td>
                        <button type="button" className={analysisStyles.linkButton} onClick={() => setOpenId(row.id)}>
                          {row.osNumber}
                        </button>
                      </td>
                      <td>{asset ? asset.code || row.unit : "—"}</td>
                      <td>{asset ? asset.model : (row.model ?? "—")}</td>
                      <td>{row.serial}</td>
                      <td>{formatDateTime(row.createdAt)}</td>
                      <td>{row.registeredBy}</td>
                      <td>{perAsset.get(row.serial.trim().toLowerCase())}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <OsMapDialog client={client} osId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
