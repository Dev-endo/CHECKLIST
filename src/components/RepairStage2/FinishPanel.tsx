import {
  FINISH_DESTINATIONS,
  needsReason,
  OUTCOME_LABELS,
  skipsChecklist,
  summarizeMaintenance,
  type FinishDestination,
  type MaintenanceItem,
} from "../../domain/repairChecklist";
import { Button } from "../Button/Button";
import { ChoiceCards } from "../ChoiceCards/ChoiceCards";
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
  /** Troca as opções de destino (ex.: Checklist manutenção: quarentena, análise técnica ou vidro). */
  destinations?: readonly { id: FinishDestination; label: string; hint: string }[];
  /** Esconde a caixa "Manutenções que contam para você" (Checklist manutenção não troca peça). */
  hideCount?: boolean;
  /** Motivo do envio para a Análise técnica (o campo aparece quando o destino é a análise). */
  analysisNote?: string;
  onAnalysisNote?: (value: string) => void;
  /** Destino Manutenção (aba Vidro): técnicos que podem receber o aparelho e o escolhido. */
  technicians?: readonly { id: string; name: string }[];
  technicianId?: string;
  onTechnician?: (id: string) => void;
}

/** Fim da manutenção: o que ainda falta e o destino (quarentena, análise técnica, vidro, revenda ou PT). */
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
  destinations = FINISH_DESTINATIONS,
  hideCount = false,
  analysisNote = "",
  onAnalysisNote,
  technicians = [],
  technicianId = "",
  onTechnician,
}: FinishPanelProps) {
  const blocked = blockers.length > 0;
  const summary = summarizeMaintenance(maintenanceItems);
  return (
    <section className={styles.finish} aria-label="Finalizar manutenção">
      <h2 className={styles.heading}>{title}</h2>

      {!hideCount && (
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
      )}

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
        <ChoiceCards
          name="finish-destination"
          legend="Para onde o aparelho vai?"
          options={destinations}
          value={destination}
          onChange={onDestination}
          disabled={busy}
        />
      )}
      {outcome === "analise" && onAnalysisNote && (
        <label className={styles.reason}>
          Por que o aparelho vai para a Análise técnica? (obrigatório)
          <textarea
            value={analysisNote}
            rows={3}
            maxLength={1000}
            disabled={busy}
            placeholder="Descreva o defeito ou o motivo do envio"
            onChange={(e) => onAnalysisNote(e.target.value)}
          />
        </label>
      )}
      {!onlyAuto && destination === "analise" && (
        <p className={styles.muted}>Para a Análise técnica não precisa dos testes com o aparelho fechado (se fez algum, ele fica salvo).</p>
      )}
      {!onlyAuto && destination === "manutencao" && onTechnician && (
        <label className={styles.reason}>
          Para qual técnico de manutenção vai o aparelho? (obrigatório)
          <select value={technicianId} disabled={busy} onChange={(e) => onTechnician(e.target.value)}>
            <option value="">{technicians.length ? "Escolha o técnico…" : "Nenhum técnico de manutenção encontrado"}</option>
            {technicians.map((technician) => (
              <option key={technician.id} value={technician.id}>
                {technician.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!onlyAuto && skipsChecklist(destination) && (
        <p className={styles.muted}>Não precisa do checklist para este destino (se fez algum teste, ele fica salvo).</p>
      )}
      {!onlyAuto && needsReason(destination) && (
        <label className={styles.reason}>
          {destination === "pt"
            ? "Motivo do PT (obrigatório)"
            : destination === "bloqueado"
              ? "Motivo do bloqueio (obrigatório)"
              : destination === "manutencao"
                ? "Motivo do envio para a manutenção (obrigatório)"
                : "Motivo da revenda (obrigatório)"}
          <textarea
            value={resaleReason}
            rows={3}
            maxLength={1000}
            disabled={busy}
            placeholder={
              destination === "pt"
                ? "Por que o aparelho é perda total?"
                : destination === "bloqueado"
                  ? "Qual o bloqueio? (conta, MDM, operadora…)"
                  : destination === "manutencao"
                    ? "O que o técnico de manutenção precisa resolver? (ex.: teste que falhou)"
                    : "Por que o aparelho vai para a revenda?"
            }
            onChange={(e) => onReason(e.target.value)}
          />
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
