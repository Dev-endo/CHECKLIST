import { useEffect, useRef, useState } from "react";
import { MAINTENANCE_ITEMS, toggleMaintenance, type Maintenance } from "../../domain/maintenance";
import { Button } from "../Button/Button";
import styles from "../MaintenanceDialog/MaintenanceDialog.module.css";

interface AssemblyFailureDialogProps {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (parts: Maintenance[]) => void;
}

/** Aparece ao concluir uma montagem reprovada: em qual peça deu erro. */
export function AssemblyFailureDialog({ open, busy = false, onCancel, onConfirm }: AssemblyFailureDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [parts, setParts] = useState<Maintenance[]>([]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setParts([]);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const ready = parts.length > 0;

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="assembly-failure-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="assembly-failure-title" className={styles.title}>
        Aparelho reprovado na montagem
      </h2>
      <p className={styles.help}>Marque em qual peça deu erro.</p>

      <div className={styles.grid}>
        {MAINTENANCE_ITEMS.map((item) => (
          <label key={item} className={styles.option}>
            <input
              type="checkbox"
              checked={parts.some((part) => part.item === item)}
              disabled={busy}
              onChange={() => setParts((prev) => toggleMaintenance(prev, item))}
            />
            <span>{item}</span>
          </label>
        ))}
      </div>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
        <Button onClick={() => onConfirm(parts)} disabled={busy || !ready}>
          {busy ? "Concluindo…" : "Concluir como reprovado"}
        </Button>
      </div>
      {!ready && <p className={styles.warn}>Marque ao menos uma peça.</p>}
    </dialog>
  );
}
