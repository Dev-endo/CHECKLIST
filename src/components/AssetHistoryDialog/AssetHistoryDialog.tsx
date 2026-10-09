import { useEffect, useRef, useState } from "react";
import { describeFailures, hasFaceIdDefect, isPending, latestReleasingId, type DeviceRecord } from "../../domain/device";
import { blameLabel, describeMaintenance, destinationLabel } from "../../domain/maintenance";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchAssetHistory } from "../../services/supabase/releaseService";
import { formatDateTime } from "../../utils/format";
import { Button } from "../Button/Button";
import styles from "./AssetHistoryDialog.module.css";

interface AssetHistoryDialogProps {
  client: AppSupabaseClient;
  /** Serial do aparelho; null mantém a janela fechada. */
  serial: string | null;
  onClose: () => void;
}

/** Tudo o que foi feito em um aparelho (serial): cada checklist, quem fez, as manutenções e quem o liberou. */
export function AssetHistoryDialog({ client, serial, onClose }: AssetHistoryDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [history, setHistory] = useState<DeviceRecord[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (serial && !element.open) element.showModal();
    if (!serial && element.open) element.close();
  }, [serial]);

  useEffect(() => {
    if (!serial) return;
    let active = true;
    setHistory(null);
    setFailed(false);
    fetchAssetHistory(client, serial)
      .then((records) => active && setHistory(records))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, serial]);

  const releasingId = history ? latestReleasingId(history) : undefined;
  const maintenanceCount = history?.reduce((sum, record) => sum + (record.manutencoes?.length ?? 0), 0) ?? 0;

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="asset-history-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="asset-history-title" className={styles.title}>
        Histórico do aparelho
      </h2>
      <p className={styles.serial}>{serial}</p>

      {failed && <p className={styles.empty}>Não foi possível carregar o histórico.</p>}
      {!failed && !history && <p className={styles.empty}>Carregando…</p>}
      {history && (
        <>
          <p className={styles.summary}>
            {history.length} {history.length === 1 ? "checklist" : "checklists"} · {maintenanceCount}{" "}
            {maintenanceCount === 1 ? "manutenção" : "manutenções"}
          </p>
          <ol className={styles.list}>
            {history.map((record) => {
              const failures = describeFailures(record.r, record.tipo);
              const releasing = record.id === releasingId;
              return (
                <li key={record.id} className={[styles.item, releasing && styles.releasing].filter(Boolean).join(" ")}>
                  <div className={styles.head}>
                    <span className={styles.who}>{record.colaborador || record.tec || "—"}</span>
                    <span className={styles.when}>{formatDateTime(record.atualizado)}</span>
                  </div>
                  <div className={styles.badges}>
                    <span className={styles.badge}>{record.tipo === "montagem" ? "Montagem" : "Manutenção"}</span>
                    <span className={styles.badge}>{isPending(record) ? "Pendente" : "Concluído"}</span>
                    {record.destino === "analise" && <span className={styles.badge}>Análise técnica</span>}
                    {hasFaceIdDefect(record.r, record.tipo) && (
                      <span className={[styles.badge, styles.fail].join(" ")}>Liberado para revenda</span>
                    )}
                    <span
                      className={[
                        styles.badge,
                        record.status === "liberado" ? styles.ok : record.status === "reprovado" ? styles.fail : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {record.status === "liberado" ? (record.destino === "vidro" ? "Enviado para vidro" : "Liberado") : record.status === "reprovado" ? "Reprovado" : "Incompleto"}
                    </span>
                    {releasing && record.destino === "montagem" && (
                      <span className={[styles.badge, styles.ok, styles.strong].join(" ")}>{destinationLabel(record.destino)}</span>
                    )}
                  </div>
                  {failures.length > 0 && (
                    <ul className={styles.failures}>
                      {failures.map((failure) => (
                        <li key={failure}>{failure}</li>
                      ))}
                    </ul>
                  )}
                  {record.tipo === "montagem" && record.status === "reprovado" && (
                    <p className={styles.maintenances}>
                      {record.culpa ? `${blameLabel(record.culpa)}` : "Reprovado na montagem"}
                      {record.pecas && record.pecas.length > 0 && ` · Peças: ${record.pecas.map(describeMaintenance).join(", ")}`}
                    </p>
                  )}
                  {record.manutencoes && record.manutencoes.length > 0 && (
                    <p className={styles.maintenances}>Manutenções: {record.manutencoes.map(describeMaintenance).join(" · ")}</p>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
      </div>
    </dialog>
  );
}
