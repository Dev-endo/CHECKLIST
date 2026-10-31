import { KIND_LABELS } from "../../domain/checklist";
import { computeStats, describeFailures, isPending, isResale, splitAssetId, totalTests, type DeviceRecord } from "../../domain/device";
import { describeMaintenance, destinationLabel, destinationLabelFor } from "../../domain/maintenance";
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
  /** Falso esconde o botão Abrir (etapas que não abrem no checklist de manutenção). */
  canOpen?: boolean;
}

export function RecordRow({ record, isCurrent, onOpen, onRestart, showOwner = false, released = false, onHistory, canOpen = true }: RecordRowProps) {
  const computed = computeStats(record.r, record.tipo);
  // Concluído vale o resultado gravado (inclui a reprovação manual da montagem).
  const stats = isPending(record) || !record.status ? computed : { ...computed, status: record.status };
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
            label: record.destino ? destinationLabelFor(record.tipo, record.destino) : "Liberado",
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
          {showOwner && `${KIND_LABELS[record.tipo ?? "manutencao"]} · `}
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
        {record.tipo === "montagem" && record.status === "reprovado" && record.pecas && record.pecas.length > 0 && (
          <p className={styles.maintenances}>Peças com erro: {record.pecas.map(describeMaintenance).join(" · ")}</p>
        )}
        {record.observacao && <p className={styles.maintenances}>Obs.: {record.observacao}</p>}
        {record.manutencoes && record.manutencoes.length > 0 && (
          <p className={styles.maintenances}>Manutenções: {record.manutencoes.map(describeMaintenance).join(" · ")}</p>
        )}
      </div>
      <span className={[styles.badge, pending && styles.pending].filter(Boolean).join(" ")}>
        {pending ? "Pendente" : "Concluído"}
      </span>
      <span className={[styles.badge, badge.className].filter(Boolean).join(" ")}>{badge.label}</span>
      {record.destino === "manutencao" && badge.label !== destinationLabelFor(record.tipo, "manutencao") && <span className={[styles.badge, styles.pending].join(" ")}>{destinationLabelFor(record.tipo, "manutencao")}</span>}
      {record.destino === "analise" && <span className={[styles.badge, styles.pending].join(" ")}>Análise técnica</span>}
      {record.destino === "aguardando_peca" && <span className={[styles.badge, styles.pending].join(" ")}>Aguardando peça</span>}
      {record.destino === "alocacao_peca" && <span className={[styles.badge, styles.pending].join(" ")}>Alocação de peça</span>}
      {record.destino === "pt" && <span className={[styles.badge, styles.pending].join(" ")}>PT</span>}
      {isResale(record) && <span className={[styles.badge, styles.fail].join(" ")}>Liberado para revenda</span>}
      {isCurrent ? (
        <span className={styles.meta}>aberto</span>
      ) : (
        <div className={styles.actions}>
          {canOpen && (
            <Button variant="small" onClick={() => onOpen(record)}>
              {pending && onRestart ? "Retomar" : "Abrir"}
            </Button>
          )}
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
