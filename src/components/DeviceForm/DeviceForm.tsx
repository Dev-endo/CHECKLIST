import type { DeviceDraft, DraftField } from "../../domain/device";
import styles from "./DeviceForm.module.css";

const FIELDS: { field: DraftField; label: string; placeholder?: string }[] = [
  { field: "modelo", label: "Modelo", placeholder: "ex.: iPhone 13" },
  { field: "serial", label: "IMEI / nº de série" },
  { field: "tec", label: "Técnico" },
];

interface DeviceFormProps {
  draft: DeviceDraft;
  onChange: (field: DraftField, value: string) => void;
  disabled?: boolean;
}

export function DeviceForm({ draft, onChange, disabled }: DeviceFormProps) {
  return (
    <div className={styles.fields}>
      {FIELDS.map(({ field, label, placeholder }) => (
        <label key={field} className={styles.field}>
          {label}
          <input
            value={draft[field]}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange(field, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}
