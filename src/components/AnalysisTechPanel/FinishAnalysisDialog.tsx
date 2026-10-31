import { useEffect, useRef, useState } from "react";
import { PURPOSE_LABELS, type RequestPurpose } from "../../domain/repairStages";
import { STOCK_PARTS } from "../../domain/stock";
import type { AnalysisPart, AnalysisResult } from "../../services/supabase/analysisTechService";
import { Button } from "../Button/Button";
import dialogStyles from "../MaintenanceDialog/MaintenanceDialog.module.css";
import styles from "./AnalysisTechPanel.module.css";

interface FinishAnalysisDialogProps {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  /** self: o próprio analista faz a troca (não volta ao Estágio 2). */
  onConfirm: (result: AnalysisResult, parts: AnalysisPart[], self: boolean) => void;
  /** Peças de teste da análise marcadas como definitivas: vão junto com o aparelho (dispensam pedir outra). */
  keptParts?: string[];
}

const RESULTS: { id: AnalysisResult; label: string; hint: string }[] = [
  { id: "troca_periferico", label: "Troca de periférico", hint: "Escolha as peças (de teste ou definitivas) e quem faz a troca: você mesmo ou quem mandou para a análise." },
  { id: "reparo_placa", label: "Reparo em placa", hint: "O aparelho passa para a aba Reparo em placa, onde você inicia o reparo (com cronômetro) e finaliza com a observação do serviço." },
];

/** Balão do fim da análise: reparo em placa ou troca de periférico (com as peças, de teste ou definitivas). */
export function FinishAnalysisDialog({ open, busy = false, onCancel, onConfirm, keptParts = [] }: FinishAnalysisDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [result, setResult] = useState<AnalysisResult | undefined>();
  // Troca de periférico: o próprio analista faz (padrão) ou devolve a quem mandou para a análise.
  const [self, setSelf] = useState(true);
  // Peça marcada -> finalidade e quantidade (a quantidade só vale na definitiva).
  const [selected, setSelected] = useState<Record<string, { purpose: RequestPurpose; qty: number }>>({});

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setResult(undefined);
      setSelf(true);
      setSelected({});
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const parts = Object.keys(selected);
  const warn = !result ? "Escolha o resultado da análise." : result === "troca_periferico" && !parts.length && !keptParts.length ? "Marque as peças que serão trocadas." : null;

  const toggle = (part: string) =>
    setSelected((prev) => {
      const next = { ...prev };
      if (part in next) delete next[part];
      else next[part] = { purpose: "definitiva", qty: 1 };
      return next;
    });

  const change = (part: string, patch: Partial<{ purpose: RequestPurpose; qty: number }>) =>
    setSelected((prev) => ({ ...prev, [part]: { ...(prev[part] ?? { purpose: "definitiva", qty: 1 }), ...patch } }));

  const confirm = () => {
    if (warn || !result) return;
    onConfirm(
      result,
      parts.map((part) => {
        const entry = selected[part] ?? { purpose: "definitiva" as const, qty: 1 };
        return { part, purpose: entry.purpose, qty: entry.purpose === "teste" ? 1 : entry.qty };
      }),
      self,
    );
  };

  return (
    <dialog
      ref={dialog}
      className={dialogStyles.dialog}
      aria-labelledby="finish-analysis-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="finish-analysis-title" className={dialogStyles.title}>
        Finalizar análise
      </h2>
      <p className={dialogStyles.help}>O que a análise concluiu?</p>

      <fieldset className={dialogStyles.destination} disabled={busy}>
        <legend>Resultado</legend>
        {RESULTS.map((option) => (
          <label key={option.id} className={dialogStyles.option}>
            <input type="radio" name="analysis-result" checked={result === option.id} onChange={() => setResult(option.id)} />
            <span>
              <strong>{option.label}</strong>
              <br />
              <small>{option.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>

      {result === "troca_periferico" && (
        <>
          <fieldset className={dialogStyles.destination} disabled={busy}>
            <legend>Quem faz a troca?</legend>
            <label className={dialogStyles.option}>
              <input type="radio" name="analysis-self" checked={self} onChange={() => setSelf(true)} />
              <span>
                <strong>Eu mesmo</strong>
                <br />
                <small>Você recebe as peças, faz a troca, os checklists e a montagem aqui na Análise técnica; aprovado, vai para a quarentena.</small>
              </span>
            </label>
            <label className={dialogStyles.option}>
              <input type="radio" name="analysis-self" checked={!self} onChange={() => setSelf(false)} />
              <span>
                <strong>Quem mandou para a análise</strong>
                <br />
                <small>O aparelho volta ao Estágio 2 dele, com os pedidos de peça.</small>
              </span>
            </label>
          </fieldset>
          {keptParts.length > 0 && (
            <p className={dialogStyles.help}>
              Vai junto com o aparelho (peça de teste usada como definitiva): <strong>{keptParts.join(", ")}</strong>. Marque abaixo só se
              precisar pedir outra peça.
            </p>
          )}
          <p className={dialogStyles.help}>Marque as peças e diga se cada uma é de teste ou definitiva.</p>
          <div className={styles.partGrid}>
            {STOCK_PARTS.map((part) => {
              const entry = selected[part];
              return (
                <div key={part} className={[styles.partChip, entry ? styles.partOn : ""].join(" ")}>
                  <label>
                    <input type="checkbox" checked={Boolean(entry)} disabled={busy} onChange={() => toggle(part)} />
                    <span>{part}</span>
                  </label>
                  {entry && (
                    <span className={styles.partControls}>
                      <select
                        value={entry.purpose}
                        aria-label={`Finalidade de ${part}`}
                        disabled={busy}
                        onChange={(e) => change(part, { purpose: e.target.value as RequestPurpose })}
                      >
                        {(["definitiva", "teste"] as const).map((purpose) => (
                          <option key={purpose} value={purpose}>
                            {PURPOSE_LABELS[purpose]}
                          </option>
                        ))}
                      </select>
                      {entry.purpose === "definitiva" && (
                        <input
                          type="number"
                          min={1}
                          max={99}
                          value={entry.qty}
                          aria-label={`Quantidade de ${part}`}
                          disabled={busy}
                          onChange={(e) => change(part, { qty: Math.min(99, Math.max(1, Number(e.target.value) || 1)) })}
                        />
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className={dialogStyles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
        <Button onClick={confirm} disabled={busy || Boolean(warn)}>
          {busy ? "Finalizando…" : "Finalizar análise"}
        </Button>
      </div>
      {warn && <p className={dialogStyles.warn}>{warn}</p>}
    </dialog>
  );
}
