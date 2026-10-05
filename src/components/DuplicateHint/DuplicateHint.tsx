import { findDuplicate, hasContent, type DeviceDraft, type DeviceRecord } from "../../domain/device";
import { formatDateTime } from "../../utils/format";
import { Button } from "../Button/Button";
import styles from "./DuplicateHint.module.css";

interface DuplicateHintProps {
  draft: DeviceDraft;
  records: readonly DeviceRecord[];
  onOpen: (record: DeviceRecord) => void;
}

/** Avisa sobre serial repetido ou ausente. */
export function DuplicateHint({ draft, records, onOpen }: DuplicateHintProps) {
  const duplicate = findDuplicate(draft, records);

  if (duplicate) {
    return (
      <div className={styles.hint}>
        Já existe um registro deste serial ({formatDateTime(duplicate.atualizado)}).
        <Button variant="small" onClick={() => onOpen(duplicate)}>
          Abrir registro
        </Button>
      </div>
    );
  }

  if (!draft.serial && hasContent(draft)) {
    return <div className={styles.hint}>Preencha o IMEI / nº de série para identificar este aparelho.</div>;
  }

  return null;
}
