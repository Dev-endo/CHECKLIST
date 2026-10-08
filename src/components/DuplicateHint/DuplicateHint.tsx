import {
  computeStats,
  findDuplicate,
  hasContent,
  isIdentified,
  isPending,
  TOTAL_TESTS,
  type DeviceDraft,
  type DeviceRecord,
} from "../../domain/device";
import { formatDateTime } from "../../utils/format";
import { Button } from "../Button/Button";
import styles from "./DuplicateHint.module.css";

interface DuplicateHintProps {
  draft: DeviceDraft;
  records: readonly DeviceRecord[];
  onOpen: (record: DeviceRecord) => void;
  onRestart: (record: DeviceRecord) => void;
}

/** Avisa sobre serial repetido (pendente ou concluído) e sobre campos que faltam para salvar. */
export function DuplicateHint({ draft, records, onOpen, onRestart }: DuplicateHintProps) {
  const duplicate = findDuplicate(draft, records);

  if (duplicate && isPending(duplicate)) {
    const { done } = computeStats(duplicate.r);
    return (
      <div className={styles.hint}>
        <span>
          Já existe um checklist <b>pendente</b> deste serial ({done}/{TOTAL_TESTS} tópicos,{" "}
          {formatDateTime(duplicate.atualizado)}). O salvamento deste aparelho fica pausado até você escolher.
        </span>
        <Button variant="small" onClick={() => onOpen(duplicate)}>
          Retomar
        </Button>
        <Button variant="small" onClick={() => onRestart(duplicate)}>
          Reiniciar checklist
        </Button>
      </div>
    );
  }

  if (duplicate) {
    return (
      <div className={styles.hint}>
        <span>Este serial já tem um checklist concluído ({formatDateTime(duplicate.atualizado)}).</span>
        <Button variant="small" onClick={() => onOpen(duplicate)}>
          Ver registro
        </Button>
      </div>
    );
  }

  if (hasContent(draft) && !isIdentified(draft)) {
    return <div className={styles.hint}>Preencha serial, modelo e técnico para o checklist ser salvo.</div>;
  }

  return null;
}
