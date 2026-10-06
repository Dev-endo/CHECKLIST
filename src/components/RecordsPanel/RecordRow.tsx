import { computeStats, isPending, TOTAL_TESTS, type DeviceRecord } from "../../domain/device";
import { formatDateTime } from "../../utils/format";
import { Button } from "../Button/Button";
import styles from "./RecordsPanel.module.css";

interface RecordRowProps {
  record: DeviceRecord;
  isCurrent: boolean;
  onOpen: (record: DeviceRecord) => void;
  /** Ausente quando o usuário não pode alterar o registro (lista de consulta). */
  onRestart?: (record: DeviceRecord) => void;
  /** Mostra quem fez o checklist (consulta de supervisor e admin). */
  showOwner?: boolean;
}

export function RecordRow({ record, isCurrent, onOpen, onRestart, showOwner = false }: RecordRowProps) {
  const stats = computeStats(record.r);
  const pending = isPending(record);
  const badge =
    stats.status === "liberado"
      ? { className: styles.ok, label: "Liberado" }
      : stats.status === "reprovado"
        ? { className: styles.fail, label: `Reprovado · ${stats.fails.length}` }
        : { className: undefined, label: `${stats.done}/${TOTAL_TESTS}` };

  return (
    <div className={[styles.row, isCurrent && styles.current].filter(Boolean).join(" ")}>
      <div>
        <div className={styles.title}>
          {record.modelo || "Sem modelo"} · {record.serial || "sem serial"}
        </div>
        <div className={styles.meta}>
          {formatDateTime(record.atualizado)}
          {record.tec && ` · ${record.tec}`}
          {showOwner && record.colaborador && ` · ${record.colaborador}`}
        </div>
      </div>
      <span className={[styles.badge, pending && styles.pending].filter(Boolean).join(" ")}>
        {pending ? "Pendente" : "Concluído"}
      </span>
      <span className={[styles.badge, badge.className].filter(Boolean).join(" ")}>{badge.label}</span>
      {isCurrent ? (
        <span className={styles.meta}>aberto</span>
      ) : (
        <div className={styles.actions}>
          <Button variant="small" onClick={() => onOpen(record)}>
            {pending && onRestart ? "Retomar" : "Abrir"}
          </Button>
          {pending && onRestart && (
            <Button variant="small" onClick={() => onRestart(record)}>
              Reiniciar
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
