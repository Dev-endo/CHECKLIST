import type { ChecklistKind } from "../../domain/checklist";
import { computeStats, totalTests, type Results } from "../../domain/device";
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
  /** Qual checklist: define o total de tópicos; padrão: manutenção. */
  kind?: ChecklistKind;
  results: Results;
  saveState: SaveState;
  /** "edit": checklist pendente do usuário; "view": concluído ou de outra pessoa. */
  mode: "edit" | "view";
  busy?: boolean;
  onConclude: () => void;
  onNewDevice: () => void;
}

export function StatusBar({ kind = "manutencao", results, saveState, mode, busy = false, onConclude, onNewDevice }: StatusBarProps) {
  const total = totalTests(kind);
  const { done, fails, status } = computeStats(results, kind);

  const summary =
    status === "reprovado"
      ? {
          className: styles.fail,
          text: `Reprovado · ${fails.length} falha${fails.length > 1 ? "s" : ""} · ${done}/${total}`,
        }
      : status === "liberado"
        ? { className: styles.ok, text: `Liberado · ${total}/${total} OK` }
        : { className: undefined, text: `${done} de ${total} tópicos` };

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
            aria-valuemax={total}
            aria-valuenow={done}
          >
            <i style={{ width: `${(done / total) * 100}%` }} />
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
