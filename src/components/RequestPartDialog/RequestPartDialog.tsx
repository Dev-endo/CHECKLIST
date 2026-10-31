import { useEffect, useRef, useState } from "react";
import { STOCK_PARTS } from "../../domain/stock";
import { Button } from "../Button/Button";
import styles from "../MaintenanceDialog/MaintenanceDialog.module.css";

interface RequestPartDialogProps {
  open: boolean;
  busy?: boolean;
  /** nova: peça para a manutenção. teste: peça emprestada para testar. */
  kind: "nova" | "teste";
  onCancel: () => void;
  onConfirm: (part: string) => void;
}

const TITLES = { nova: "Solicitar nova peça", teste: "Solicitar peça para teste" } as const;

/** Balão em que o técnico (ou o desmontador) escolhe qual peça pedir ao estoque. */
export function RequestPartDialog({ open, busy = false, kind, onCancel, onConfirm }: RequestPartDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [part, setPart] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setPart("");
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="request-part-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="request-part-title" className={styles.title}>
        {TITLES[kind]}
      </h2>
      <p className={styles.help}>O estoquista recebe um aviso com o seu nome.</p>
      <div className={styles.grid}>
        {STOCK_PARTS.map((item) => (
          <label key={item} className={styles.option}>
            <input type="radio" name="request-part" checked={part === item} disabled={busy} onChange={() => setPart(item)} />
            <span>{item}</span>
          </label>
        ))}
      </div>
      <div className={styles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
        <Button onClick={() => onConfirm(part)} disabled={busy || !part}>
          {busy ? "Enviando…" : "Solicitar"}
        </Button>
      </div>
    </dialog>
  );
}
