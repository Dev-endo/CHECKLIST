import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "../Button/Button";
import styles from "./OverviewDialog.module.css";

interface OverviewDialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** Balão da visão geral do estoque: abre ao clicar em um dos contadores. */
export function OverviewDialog({ open, title, onClose, children }: OverviewDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        <Button variant="small" onClick={onClose}>
          Fechar
        </Button>
      </div>
      {open && <div className={styles.body}>{children}</div>}
    </dialog>
  );
}
