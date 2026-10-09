import { computeStats, describeFailures, isPending, splitAssetId, totalTests, type DeviceRecord } from "../../domain/device";
import { describeMaintenance, destinationLabel } from "../../domain/maintenance";
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
  /** Este checklist deixou o aparelho liberado para montagem (último concluído do serial). */
  released?: boolean;
  /** Abre o histórico do serial (consulta de supervisor e admin). */
  onHistory?: (record: DeviceRecord) => void;
}

export function RecordRow({ record, isCurrent, onOpen, onRestart, showOwner = false, released = false, onHistory }: RecordRowProps) {
  const stats = computeStats(record.r, record.tipo);
  const pending = isPending(record);
  const failures = describeFailures(record.r, record.tipo);
  // O técnico já é o nome do usuário; o colaborador só aparece se for outra pessoa.
  const sameName = (a?: string, b?: string) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  const showCollaborator = Boolean(record.colaborador) && !sameName(record.colaborador, record.tec);
  const badge =
    stats.status === "liberado"
      ? record.destino === "vidro"
        ? // Vidro não é liberação: o aparelho segue em manutenção.
          { className: styles.pending, label: destinationLabel("vidro") }
        : {
            className: released && record.destino === "montagem" ? `${styles.ok} ${styles.assembly}` : styles.ok,
            label: record.destino ? destinationLabel(record.destino) : "Liberado",
          }
      : stats.status === "reprovado"
        ? { className: styles.fail, label: `Reprovado · ${stats.fails.length}` }
        : { className: undefined, label: `${stats.done}/${totalTests(record.tipo)}` };

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
        {record.manutencoes && record.manutencoes.length > 0 && (
          <p className={styles.maintenances}>Manutenções: {record.manutencoes.map(describeMaintenance).join(" · ")}</p>
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
          {onHistory && record.serial && (
            <Button variant="small" onClick={() => onHistory(record)}>
              Histórico
            </Button>
          )}
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
