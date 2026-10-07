import { computeStats, describeFailures, isPending, splitAssetId, TOTAL_TESTS, type DeviceRecord } from "../../domain/device";
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
  const failures = describeFailures(record.r);
  // O técnico já é o nome do usuário; o colaborador só aparece se for outra pessoa.
  const sameName = (a?: string, b?: string) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  const showCollaborator = Boolean(record.colaborador) && !sameName(record.colaborador, record.tec);
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
          {record.bateria !== undefined && `Bateria ${record.bateria}% · `}
          {record.ativo && `Unit ${splitAssetId(record.ativo).code || record.ativo} · `}
          {formatDateTime(record.atualizado)}
          {record.tec && ` · ${record.tec}`}
          {showOwner && showCollaborator && ` · ${record.colaborador}`}
        </div>
        {failures.length > 0 && (
          <ul className={styles.failures} aria-label="Falhas">
            {failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        )}
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
