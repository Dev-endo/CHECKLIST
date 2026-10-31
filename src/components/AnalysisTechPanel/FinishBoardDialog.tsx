import { useEffect, useRef, useState } from "react";
import type { BoardDestination } from "../../services/supabase/analysisTechService";
import { Button } from "../Button/Button";
import dialogStyles from "../MaintenanceDialog/MaintenanceDialog.module.css";
import styles from "./AnalysisTechPanel.module.css";

interface FinishBoardDialogProps {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (note: string, destination: BoardDestination) => void;
}

const DESTINATIONS: { id: BoardDestination; label: string; hint: string }[] = [
  { id: "quarentena", label: "Checklist e montagem → Quarentena", hint: "Não há mais nenhum reparo: os checklists e a montagem abrem aqui em seguida; tudo aprovado, o aparelho vai para a quarentena." },
  { id: "vidro", label: "Vidro", hint: "Entra no mesmo processo de vidro: pede Vidro e Aro ao estoque e abre o serviço na aba Vidro; depois volta a quem mandou para a análise." },
  { id: "estagio2", label: "Estágio 2", hint: "Ainda há outro reparo: o aparelho vai ao Estágio 2 de quem mandou para a análise." },
];

const MIN_NOTE = 5;

/** Balão do fim do reparo em placa: descreve o serviço feito (obrigatório) e escolhe para onde o aparelho vai. */
export function FinishBoardDialog({ open, busy = false, onCancel, onConfirm }: FinishBoardDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState("");
  const [destination, setDestination] = useState<BoardDestination | undefined>();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setNote("");
      setDestination(undefined);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const warn =
    note.trim().length < MIN_NOTE ? "Descreva o serviço feito na placa." : !destination ? "Escolha para onde o aparelho vai." : null;

  return (
    <dialog
      ref={dialog}
      className={dialogStyles.dialog}
      aria-labelledby="finish-board-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="finish-board-title" className={dialogStyles.title}>
        Finalizar reparo em placa
      </h2>

      <label className={dialogStyles.detail}>
        Serviço feito na placa (obrigatório)
        <textarea
          value={note}
          maxLength={500}
          rows={4}
          disabled={busy}
          placeholder="Ex.: troca do CI de carga, reparo de trilha, reballing…"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>

      <fieldset className={dialogStyles.destination} disabled={busy}>
        <legend>Para onde o aparelho vai?</legend>
        {DESTINATIONS.map((option) => (
          <label key={option.id} className={dialogStyles.option}>
            <input type="radio" name="board-destination" checked={destination === option.id} onChange={() => setDestination(option.id)} />
            <span>
              <strong>{option.label}</strong>
              <br />
              <small className={styles.muted}>{option.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <div className={dialogStyles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
        <Button onClick={() => destination && !warn && onConfirm(note.trim(), destination)} disabled={busy || Boolean(warn)}>
          {busy ? "Finalizando…" : "Finalizar reparo"}
        </Button>
      </div>
      {warn && <p className={dialogStyles.warn}>{warn}</p>}
    </dialog>
  );
}
