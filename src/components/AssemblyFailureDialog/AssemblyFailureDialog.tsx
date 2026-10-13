import { useEffect, useRef, useState } from "react";
import {
  ASSEMBLY_REJECT_DESTINATIONS,
  MAINTENANCE_ITEMS,
  toggleMaintenance,
  type Destination,
  type Maintenance,
} from "../../domain/maintenance";
import { Button } from "../Button/Button";
import styles from "../MaintenanceDialog/MaintenanceDialog.module.css";

export const NOTE_MAX = 500;

interface AssemblyFailureDialogProps {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (parts: Maintenance[], destination: Destination, note: string) => void;
}

/** Reprovar na montagem: a peça com erro, uma observação e para onde o aparelho vai. */
export function AssemblyFailureDialog({ open, busy = false, onCancel, onConfirm }: AssemblyFailureDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [parts, setParts] = useState<Maintenance[]>([]);
  const [note, setNote] = useState("");
  const [destination, setDestination] = useState<Destination | undefined>();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setParts([]);
      setNote("");
      setDestination(undefined);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const ready = parts.length > 0 && destination !== undefined;

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
        Reprovar aparelho na montagem
      </h2>
      <p className={styles.help}>Marque em qual peça deu erro, escreva uma observação (se quiser) e escolha para onde o aparelho vai.</p>

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

      <label className={styles.detail}>
        Observação
        <textarea
          className={styles.note}
          value={note}
          maxLength={NOTE_MAX}
          rows={3}
          disabled={busy}
          placeholder="Escreva o que aconteceu (opcional)"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>

      <fieldset className={styles.destination} disabled={busy}>
        <legend>Para onde o aparelho vai?</legend>
        {ASSEMBLY_REJECT_DESTINATIONS.map(({ id, label }) => (
          <label key={id} className={styles.option}>
            <input type="radio" name="reject-destination" checked={destination === id} onChange={() => setDestination(id)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
        <Button variant="danger" onClick={() => destination && onConfirm(parts, destination, note.trim())} disabled={busy || !ready}>
          {busy ? "Concluindo…" : "Reprovar aparelho"}
        </Button>
      </div>
      {!ready && <p className={styles.warn}>Marque ao menos uma peça e escolha para onde o aparelho vai.</p>}
    </dialog>
  );
}
