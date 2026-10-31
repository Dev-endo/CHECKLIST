import { useEffect, useRef, useState } from "react";
import { STOCK_PARTS } from "../../domain/stock";
import type { Borrower } from "../../services/supabase/stockService";
import { Button } from "../Button/Button";
import styles from "../MaintenanceDialog/MaintenanceDialog.module.css";

interface LendTestDialogProps {
  open: boolean;
  busy?: boolean;
  model: string;
  borrowers: readonly Borrower[];
  /** Peças que já estão emprestadas na OS: não podem ser escolhidas de novo. */
  taken: readonly string[];
  onCancel: () => void;
  onConfirm: (part: string, borrower: string) => void;
}

/** Balão em que o estoquista empresta uma peça de teste para um técnico ou desmontador, sem pedido. */
export function LendTestDialog({ open, busy = false, model, borrowers, taken, onCancel, onConfirm }: LendTestDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [part, setPart] = useState("");
  const [borrower, setBorrower] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setPart("");
      setBorrower("");
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="lend-test-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="lend-test-title" className={styles.title}>
        Emprestar peça para teste
      </h2>
      <p className={styles.help}>
        Aparelho: {model || "—"}. A peça fica na sua lista de peças emprestadas até voltar ao estoque, e o técnico só conclui o checklist depois
        que você liberar o uso ou confirmar a devolução.
      </p>
      <label className={styles.detail}>
        Para quem
        <select value={borrower} disabled={busy} onChange={(e) => setBorrower(e.target.value)}>
          <option value="">Selecione…</option>
          {borrowers.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.grid}>
        {STOCK_PARTS.map((item) => {
          const already = taken.includes(item);
          return (
            <label key={item} className={styles.option}>
              <input type="radio" name="lend-part" checked={part === item} disabled={busy || already} onChange={() => setPart(item)} />
              <span>{already ? `${item} (já emprestada)` : item}</span>
            </label>
          );
        })}
      </div>
      <div className={styles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
        <Button onClick={() => onConfirm(part, borrower)} disabled={busy || !part || !borrower}>
          {busy ? "Emprestando…" : "Emprestar"}
        </Button>
      </div>
    </dialog>
  );
}
