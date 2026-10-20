import { useEffect, useMemo, useState } from "react";
import { KIND_LABELS } from "../../domain/checklist";
import { splitAssetId } from "../../domain/device";
import { destinationLabelFor, MAINTENANCE_ITEMS, parseDestination } from "../../domain/maintenance";
import { fetchPartChanges, type PartChange } from "../../services/supabase/analysisSearchService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import type { MaintenanceReportFilters } from "../../services/supabase/reportService";
import { formatDateTime } from "../../utils/format";
import analysisStyles from "../AnalysisPanel/AnalysisPanel.module.css";
import reviewStyles from "../ReviewPanel/ReviewPanel.module.css";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";

interface PartsSearchViewProps {
  client: AppSupabaseClient;
  /** Período e colaborador escolhidos no topo da Análise. */
  filters: MaintenanceReportFilters;
  /** Muda a cada recarga automática da Análise. */
  reloads: number;
}

const fmt = (n: number) => n.toLocaleString("pt-BR");

/** Pesquisa por peça: em quais aparelhos ela foi trocada e quem fez a troca. */
export function PartsSearchView({ client, filters, reloads }: PartsSearchViewProps) {
  const [item, setItem] = useState("");
  const [serial, setSerial] = useState("");
  const [rows, setRows] = useState<PartChange[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    fetchPartChanges(client, item, filters)
      .then((found) => active && setRows(found))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, item, filters, reloads]);

  const query = serial.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (rows ?? []).filter(
        (row) => !query || row.serial.toLowerCase().includes(query) || (row.unit ?? "").toLowerCase().includes(query),
      ),
    [rows, query],
  );
  // Quantas trocas cada colaborador fez na pesquisa.
  const byPerson = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of shown) counts.set(row.person, (counts.get(row.person) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [shown]);

  return (
    <>
      <div className={reviewStyles.filters}>
        <label className={reviewStyles.field}>
          Peça
          <select value={item} onChange={(e) => setItem(e.target.value)}>
            <option value="">Todas as peças</option>
            {MAINTENANCE_ITEMS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className={reviewStyles.field}>
          Serial ou unit ID
          <input value={serial} placeholder="Filtrar a lista" onChange={(e) => setSerial(e.target.value)} />
        </label>
      </div>

      {failed && <div className={recordStyles.empty}>Não foi possível carregar a pesquisa.</div>}
      {!failed && !rows && <div className={recordStyles.empty}>Carregando…</div>}
      {rows && (
        <>
          <div className={analysisStyles.stats}>
            <div className={analysisStyles.stat}>
              <span className={analysisStyles.statValue}>{fmt(shown.length)}</span>
              <span className={analysisStyles.statLabel}>{item ? `Trocas de ${item}` : "Peças trocadas"}</span>
              <span className={analysisStyles.statHint}>
                manutenção e desmontagem técnica; cada peça de cada checklist conta
                {rows.length >= 2000 ? " (mostrando as 2000 mais recentes)" : ""}
              </span>
            </div>
          </div>

          <h3 className={analysisStyles.subtitle}>Quem fez as trocas</h3>
          {byPerson.length ? (
            <div className={analysisStyles.tableWrap}>
              <table className={analysisStyles.table}>
                <thead>
                  <tr>
                    <th>Colaborador</th>
                    <th>Trocas</th>
                  </tr>
                </thead>
                <tbody>
                  {byPerson.map(([name, count]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>{fmt(count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={recordStyles.empty}>Nenhuma troca encontrada neste período.</div>
          )}

          {shown.length > 0 && (
            <>
              <h3 className={analysisStyles.subtitle}>Aparelhos</h3>
              <div className={analysisStyles.tableWrap}>
                <table className={`${analysisStyles.table} ${analysisStyles.listTable}`}>
                  <thead>
                    <tr>
                      <th>Peça</th>
                      <th>Unit ID</th>
                      <th>Modelo</th>
                      <th>Serial</th>
                      <th>Etapa</th>
                      <th>Colaborador</th>
                      <th>Data</th>
                      <th>Destino</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row, index) => {
                      const asset = row.unit ? splitAssetId(row.unit) : null;
                      const destination = parseDestination(row.destination);
                      return (
                        <tr key={`${row.serial}-${row.at}-${row.item}-${index}`}>
                          <td>{row.detail ? `${row.item}: ${row.detail}` : row.item}</td>
                          <td>{asset ? asset.code || row.unit : "—"}</td>
                          <td>{asset ? asset.model : (row.model ?? "—")}</td>
                          <td>{row.serial}</td>
                          <td>{KIND_LABELS[row.stage] ?? row.stage}</td>
                          <td>{row.person}</td>
                          <td>{formatDateTime(row.at ?? undefined)}</td>
                          <td>{destination ? destinationLabelFor(row.stage, destination) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
