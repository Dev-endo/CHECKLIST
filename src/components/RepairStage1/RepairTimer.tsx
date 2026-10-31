import { formatDuration, TIMER_LABELS, type TimerTotals } from "../../domain/repairStages";
import { Button } from "../Button/Button";
import styles from "./RepairStage1.module.css";

interface RepairTimerProps {
  /** Fase a que o cronômetro pertence: desmontagem ou avaliação técnica. */
  title: string;
  totals: TimerTotals;
  action: { label: string };
  busy: boolean;
  disabled?: boolean;
  /** Esconde "Espera de peça" (a análise técnica não espera peça). */
  hideWait?: boolean;
  onToggle: () => void;
  /** Finalizar: para de contar exatamente quando a parte do trabalho acaba. */
  onFinish?: () => void;
}

/** Cronômetro da etapa: tempo produtivo em destaque, com pausas e espera de peça à parte. */
export function RepairTimer({ title, totals, action, busy, disabled = false, hideWait = false, onToggle, onFinish }: RepairTimerProps) {
  const state = totals.openKind;
  const ran = totals.produtivo + totals.pausa + totals.espera_peca > 0;
  return (
    <section className={styles.timer} aria-label={`Cronômetro: ${title}`}>
      <div className={styles.timerMain}>
        <span className={styles.timerLabel}>{title} · tempo produtivo</span>
        <span className={[styles.clock, state === "produtivo" ? styles.running : ""].join(" ")} role="timer">
          {formatDuration(totals.produtivo)}
        </span>
        <span className={styles.timerState}>{state ? TIMER_LABELS[state] : ran ? "Finalizado" : "Parado"}</span>
      </div>
      <dl className={styles.timerSide}>
        <div>
          <dt>Pausas</dt>
          <dd>{formatDuration(totals.pausa)}</dd>
        </div>
        {!hideWait && (
          <div>
            <dt>Espera de peça</dt>
            <dd>{formatDuration(totals.espera_peca)}</dd>
          </div>
        )}
      </dl>
      <span className={styles.timerButtons}>
        <Button disabled={busy || disabled} onClick={onToggle}>
          {action.label}
        </Button>
        {onFinish && state && (
          <Button
            variant="ghost"
            disabled={busy || disabled}
            onClick={() => {
              if (window.confirm(`Finalizar o cronômetro de ${title}? O tempo para de contar agora.`)) onFinish();
            }}
          >
            Finalizar
          </Button>
        )}
      </span>
    </section>
  );
}
