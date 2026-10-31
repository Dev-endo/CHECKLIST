import { OUTCOME_LABELS, summarizeMaintenance, type FinishDestination, type MaintenanceItem } from "../../domain/repairChecklist";
import { Button } from "../Button/Button";
import styles from "./RepairStage2.module.css";

interface FinishPanelProps {
  blockers: string[];
  outcome: keyof typeof OUTCOME_LABELS;
  destination: FinishDestination;
  resaleReason: string;
  busy: boolean;
  unsaved: boolean;
  onDestination: (value: FinishDestination) => void;
  onReason: (value: string) => void;
  onFinish: () => void;
  /** Título da caixa (padrão: Finalizar manutenção). */
  title?: string;
  /** Só o destino pelos testes (quarentena ou análise): sem vidro nem revenda. */
  onlyAuto?: boolean;
  /** Manutenções que contam para quem finaliza (placa e peças usadas de vez). */
  maintenanceItems?: MaintenanceItem[];
}

/** Fim da manutenção: o que ainda falta e o destino (automático, vidro ou revenda excepcional, com justificativa). */
const DESTINATIONS: { id: FinishDestination; label: string; hint: string }[] = [
  { id: "auto", label: "Pelos testes", hint: "Quarentena se tudo foi aprovado; fila de Análise se algum teste foi reprovado." },
  { id: "vidro", label: "Vidro", hint: "Pede Vidro e Aro ao estoque e abre o serviço na aba Vidro; depois o aparelho volta para você finalizar." },
  { id: "revenda", label: "Revenda", hint: "Destino excepcional: exige justificativa." },
];

export function FinishPanel({
  blockers,
  outcome,
  destination,
  resaleReason,
  busy,
  unsaved,
  onDestination,
  onReason,
  onFinish,
  title = "Finalizar manutenção",
  onlyAuto = false,
  maintenanceItems = [],
}: FinishPanelProps) {
  const blocked = blockers.length > 0;
  const summary = summarizeMaintenance(maintenanceItems);
  return (
    <section className={styles.finish} aria-label="Finalizar manutenção">
      <h2 className={styles.heading}>{title}</h2>

      <div className={styles.count}>
        <span>
          Manutenções que contam para você: <strong>{summary.count}</strong>
        </span>
        {summary.lines.length > 0 ? (
          <ul>
            {summary.lines.map((line, i) => (
              <li key={`${i}-${line}`}>{line}</li>
            ))}
          </ul>
        ) : (
          <span className={styles.muted}>Reparo em placa feito por você conta 1; cada peça usada de vez conta 1.</span>
        )}
      </div>

      {blocked ? (
        <>
          <p className={styles.muted}>Para finalizar, falta:</p>
          <ul className={styles.blockers}>
            {blockers.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className={styles.ready}>
          Tudo certo. Destino do aparelho: <strong>{OUTCOME_LABELS[outcome]}</strong>.
        </p>
      )}

      {!onlyAuto && (
      <fieldset className={styles.destinationChoice} disabled={busy}>
        <legend>Para onde o aparelho vai?</legend>
        {DESTINATIONS.map((option) => (
          <label key={option.id} className={styles.resale}>
            <input type="radio" name="finish-destination" checked={destination === option.id} onChange={() => onDestination(option.id)} />
            <span>
              <strong>{option.label}</strong> <span className={styles.muted}>{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      )}
      {destination === "revenda" && (
        <label className={styles.reason}>
          Justificativa (obrigatória)
          <textarea value={resaleReason} rows={2} maxLength={500} disabled={busy} onChange={(e) => onReason(e.target.value)} />
        </label>
      )}

      <div className={styles.actions}>
        <Button disabled={busy || blocked} onClick={onFinish}>
          {busy ? "Finalizando…" : title}
        </Button>
        {unsaved && <span className={styles.muted}>Salvando marcações…</span>}
      </div>
    </section>
  );
}
