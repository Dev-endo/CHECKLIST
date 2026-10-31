import { useEffect, useRef, useState } from "react";
import { STOCK_PARTS } from "../../domain/stock";
import { Button } from "../Button/Button";
import styles from "../MaintenanceDialog/MaintenanceDialog.module.css";

interface PartPickerDialogProps {
  open: boolean;
  busy?: boolean;
  model: string;
  /** Peças que já estão alocadas na OS atual: aparecem marcadas e não podem ser escolhidas de novo. */
  taken: readonly string[];
  onCancel: () => void;
  onConfirm: (parts: string[]) => void;
}

/** Balão em que o estoquista escolhe quais peças serão alocadas ao aparelho. */
export function PartPickerDialog({ open, busy = false, model, taken, onCancel, onConfirm }: PartPickerDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setSelected([]);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const toggle = (part: string) =>
    setSelected((prev) => (prev.includes(part) ? prev.filter((p) => p !== part) : [...prev, part]));

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="part-picker-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="part-picker-title" className={styles.title}>
        Peça para alocar
      </h2>
      <p className={styles.help}>Aparelho: {model || "—"}. Marque as peças que serão alocadas neste aparelho.</p>
      <div className={styles.grid}>
        {STOCK_PARTS.map((part) => {
          const already = taken.includes(part);
          return (
            <label key={part} className={styles.option}>
              <input
                type="checkbox"
                checked={already || selected.includes(part)}
                disabled={busy || already}
                onChange={() => toggle(part)}
              />
              <span>{already ? `${part} (já alocada)` : part}</span>
            </label>
          );
        })}
      </div>
      <div className={styles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
        <Button onClick={() => onConfirm(selected)} disabled={busy || selected.length === 0}>
          {busy ? "Alocando…" : "Alocar"}
        </Button>
      </div>
    </dialog>
  );
}
