import { computeStats, TOTAL_TESTS, type Results } from "../../domain/device";
import type { SaveState } from "../../hooks/useAutosave";
import { Button } from "../Button/Button";
import styles from "./StatusBar.module.css";

const SAVE_LABELS: Record<SaveState, string> = {
  idle: "",
  saving: "Salvando…",
  saved: "Salvo",
  error: "Não salvou. Tente de novo em instantes.",
};

interface StatusBarProps {
  results: Results;
  saveState: SaveState;
  /** "edit": checklist pendente do usuário; "view": concluído ou de outra pessoa. */
  mode: "edit" | "view";
  busy?: boolean;
  onConclude: () => void;
  onNewDevice: () => void;
}

export function StatusBar({ results, saveState, mode, busy = false, onConclude, onNewDevice }: StatusBarProps) {
  const { done, fails, status } = computeStats(results);

  const summary =
    status === "reprovado"
      ? {
          className: styles.fail,
          text: `Reprovado · ${fails.length} falha${fails.length > 1 ? "s" : ""} · ${done}/${TOTAL_TESTS}`,
        }
      : status === "liberado"
        ? { className: styles.ok, text: `Liberado · ${TOTAL_TESTS}/${TOTAL_TESTS} OK` }
        : { className: undefined, text: `${done} de ${TOTAL_TESTS} testados` };

  return (
    <div className={styles.bar}>
      <div className={styles.inner}>
        <div className={styles.progress}>
          <span className={[styles.summary, summary.className].filter(Boolean).join(" ")} aria-live="polite">
            {summary.text}
          </span>
          <div
            className={styles.track}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={TOTAL_TESTS}
            aria-valuenow={done}
          >
            <i style={{ width: `${(done / TOTAL_TESTS) * 100}%` }} />
          </div>
          <span className={styles.saved}>{SAVE_LABELS[saveState]}</span>
        </div>
        <div className={styles.actions}>
          {mode === "edit" ? (
            <Button onClick={onConclude} disabled={busy}>
              {busy ? "Concluindo…" : "Concluir"}
            </Button>
          ) : (
            <Button variant="ghost" onClick={onNewDevice}>
              Novo checklist
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
