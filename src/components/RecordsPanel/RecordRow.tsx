import { computeStats, TOTAL_TESTS, type DeviceRecord } from "../../domain/device";
import { formatDateTime } from "../../utils/format";
import { Button } from "../Button/Button";
import styles from "./RecordsPanel.module.css";

interface RecordRowProps {
  record: DeviceRecord;
  isCurrent: boolean;
  onOpen: (record: DeviceRecord) => void;
}

export function RecordRow({ record, isCurrent, onOpen }: RecordRowProps) {
  const stats = computeStats(record.r);
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
        </div>
      </div>
      <span className={[styles.badge, badge.className].filter(Boolean).join(" ")}>{badge.label}</span>
      {isCurrent ? (
        <span className={styles.meta}>aberto</span>
      ) : (
        <Button variant="small" onClick={() => onOpen(record)}>
          Abrir
        </Button>
      )}
    </div>
  );
}
