import { useEffect, useRef, useState } from "react";
import { ASSEMBLY_DESTINATIONS, type Destination } from "../../domain/maintenance";
import { Button } from "../Button/Button";
import styles from "../MaintenanceDialog/MaintenanceDialog.module.css";

interface AssemblyReleaseDialogProps {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (destination: Destination) => void;
}

/** Aparece ao concluir uma montagem aprovada: para onde o aparelho segue. */
export function AssemblyReleaseDialog({ open, busy = false, onCancel, onConfirm }: AssemblyReleaseDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [destination, setDestination] = useState<Destination | undefined>();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setDestination(undefined);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="assembly-release-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="assembly-release-title" className={styles.title}>
        Montagem aprovada
      </h2>
      <p className={styles.help}>Para onde o aparelho vai?</p>

      <fieldset className={styles.destination} disabled={busy}>
        <legend>Direcionamento</legend>
        {ASSEMBLY_DESTINATIONS.map(({ id, label }) => (
          <label key={id} className={styles.option}>
            <input type="radio" name="assembly-destination" checked={destination === id} onChange={() => setDestination(id)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
        <Button onClick={() => destination && onConfirm(destination)} disabled={busy || !destination}>
          {busy ? "Concluindo…" : "Concluir checklist"}
        </Button>
      </div>
      {!destination && <p className={styles.warn}>Escolha para onde o aparelho vai.</p>}
    </dialog>
  );
}
