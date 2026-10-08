import type { DeviceDraft, DraftField } from "../../domain/device";
import styles from "./DeviceForm.module.css";

const FIELDS: { field: DraftField; label: string; placeholder?: string }[] = [
  { field: "serial", label: "Serial", placeholder: "Bipe ou digite o serial" },
  { field: "modelo", label: "Modelo", placeholder: "ex.: iPhone 13" },
  { field: "tec", label: "Técnico" },
];

interface DeviceFormProps {
  draft: DeviceDraft;
  onChange: (field: DraftField, value: string) => void;
  disabled?: boolean;
  /** Campos preenchidos pelo sistema, que o usuário não edita. */
  lockedFields?: readonly DraftField[];
  /** Unit id do ativo reconhecido pelo serial, só para mostrar. */
  unitId?: string;
}

export function DeviceForm({ draft, onChange, disabled, lockedFields = [], unitId }: DeviceFormProps) {
  return (
    <div className={styles.fields}>
      {FIELDS.map(({ field, label, placeholder }) => (
        <label key={field} className={styles.field}>
          {label}
          <input
            value={draft[field]}
            placeholder={placeholder}
            disabled={disabled || lockedFields.includes(field)}
            autoFocus={field === "serial" && !disabled}
            onChange={(e) => onChange(field, e.target.value)}
          />
        </label>
      ))}
      {unitId !== undefined && (
        <label className={styles.field}>
          Unit ID
          <input value={unitId} disabled readOnly />
        </label>
      )}
    </div>
  );
}
