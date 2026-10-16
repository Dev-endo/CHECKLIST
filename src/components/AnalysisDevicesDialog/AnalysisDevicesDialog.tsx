import { useEffect, useRef, useState } from "react";
import { splitAssetId } from "../../domain/device";
import { destinationLabelFor, parseDestination } from "../../domain/maintenance";
import { fetchAnalysisDevices, type AnalysisDevice } from "../../services/supabase/analysisDevicesService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import type { MaintenanceReportFilters } from "../../services/supabase/reportService";
import { formatDateTime } from "../../utils/format";
import { Button } from "../Button/Button";
import analysisStyles from "../AnalysisPanel/AnalysisPanel.module.css";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import styles from "./AnalysisDevicesDialog.module.css";

const STAGE_LABELS: Record<AnalysisDevice["stage"], string> = {
  manutencao: "Manutenção",
  montagem: "Montagem",
  desmontagem: "Desmontagem",
  desmontagem_tecnica: "Desmontagem técnica",
  quarentena: "Quarentena",
};

interface AnalysisDevicesDialogProps {
  client: AppSupabaseClient;
  /** Número clicado na Análise; null mantém a janela fechada. */
  detail: { metric: string; label: string } | null;
  filters: MaintenanceReportFilters;
  onClose: () => void;
}

/** Aparelhos que compõem um número da Análise: unit id, serial, etapa, responsável e observações. */
export function AnalysisDevicesDialog({ client, detail, filters, onClose }: AnalysisDevicesDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<AnalysisDevice[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (detail && !element.open) element.showModal();
    if (!detail && element.open) element.close();
  }, [detail]);

  useEffect(() => {
    if (!detail) return;
    let active = true;
    setRows(null);
    setFailed(false);
    fetchAnalysisDevices(client, detail.metric, filters)
      .then((found) => active && setRows(found))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, detail, filters]);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="analysis-devices-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="analysis-devices-title" className={styles.title}>
        {detail?.label}
      </h2>
      {rows && <p className={styles.summary}>{rows.length} no período{rows.length >= 1000 ? " (mostrando os 1000 mais recentes)" : ""}</p>}
      {failed && <div className={recordStyles.empty}>Não foi possível carregar a lista.</div>}
      {!failed && !rows && <div className={recordStyles.empty}>Carregando…</div>}
      {rows && rows.length === 0 && <div className={recordStyles.empty}>Nenhum aparelho neste período.</div>}
      {rows && rows.length > 0 && (
        <div className={analysisStyles.tableWrap}>
          <table className={`${analysisStyles.table} ${analysisStyles.listTable}`}>
            <thead>
              <tr>
                <th>Unit ID</th>
                <th>Modelo</th>
                <th>Serial</th>
                <th>Etapa</th>
                <th>Responsável</th>
                <th>Data</th>
                <th>Destino</th>
                <th>Observações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const destination = parseDestination(row.destination);
                const asset = row.unit ? splitAssetId(row.unit) : null;
                return (
                  <tr key={`${row.serial}-${row.at}-${index}`}>
                    <td>{asset ? asset.code || row.unit : "—"}</td>
                    <td>{asset ? asset.model : "—"}</td>
                    <td className={styles.serial}>{row.serial}</td>
                    <td>{STAGE_LABELS[row.stage] ?? row.stage}</td>
                    <td>{row.person}</td>
                    <td>{formatDateTime(row.at ?? undefined)}</td>
                    <td>{destination ? destinationLabelFor(row.stage, destination) : row.stage === "quarentena" ? row.status : "—"}</td>
                    <td>{row.observations.join(" · ") || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className={styles.actions}>
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
      </div>
    </dialog>
  );
}
