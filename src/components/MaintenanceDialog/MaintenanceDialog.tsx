import { useEffect, useRef, useState } from "react";
import {
  ANALYSIS_LABEL,
  DESTINATIONS,
  isMaintenanceComplete,
  MAINTENANCE_ITEMS,
  PLACA_ITEM,
  PLACA_SERVICES,
  setMaintenanceDetail,
  toggleMaintenance,
  type Destination,
  type Maintenance,
} from "../../domain/maintenance";
import { Button } from "../Button/Button";
import styles from "./MaintenanceDialog.module.css";

interface MaintenanceDialogProps {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (maintenances: Maintenance[], destination?: Destination, blocked?: boolean, resale?: boolean) => void;
  /** Face ID com defeito: o aparelho segue para a montagem e depois para laudo e revenda. */
  faceIdDefect?: boolean;
  /** Checklist reprovado: marca as manutenções feitas e, se quiser, envia para análise técnica. */
  rejected?: boolean;
}

const PT_OPTION = { id: "pt", label: "Enviar para PT" } as const;

/** Escolha de um checklist com falha que segue sem destino: continua em manutenção. */
const STAYS = "continua";

/** Aparece ao concluir um checklist com tudo OK: quais manutenções foram feitas no aparelho. */
export function MaintenanceDialog({ open, busy = false, onCancel, onConfirm, faceIdDefect = false, rejected = false }: MaintenanceDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<Maintenance[]>([]);
  // Escolha explícita de que nenhuma manutenção foi executada.
  const [none, setNone] = useState(false);
  const [destination, setDestination] = useState<Destination | typeof STAYS | undefined>();
  // Ativo aberto e bloqueado: conta como bloqueado na análise (cada serial uma vez).
  const [blocked, setBlocked] = useState(false);
  // Aparelho vai para revenda? Sim leva direto para a montagem. Com Face ID com defeito já vem em Sim.
  const [resale, setResale] = useState<boolean | undefined>();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setSelected([]);
      setNone(false);
      setBlocked(false);
      setResale(faceIdDefect ? true : undefined);
      setDestination(undefined);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  // Com falha no checklist: montagem, análise técnica ou continua em manutenção.
  // Com Face ID com defeito (uma recusa), "enviar para análise técnica" também é um destino.
  const destinations: readonly { id: Destination | typeof STAYS; label: string }[] = rejected
    ? [
        { id: "montagem", label: "Enviar para montagem" },
        { id: "vidro", label: "Enviado para vidro" },
        { id: "analise", label: ANALYSIS_LABEL },
        PT_OPTION,
        { id: STAYS, label: "Continua em manutenção" },
      ]
    : faceIdDefect
      ? [...DESTINATIONS, { id: "analise", label: ANALYSIS_LABEL }, PT_OPTION]
      : [...DESTINATIONS, PT_OPTION];
  // Revenda: o aparelho segue para a montagem automaticamente.
  const choice: Destination | typeof STAYS | undefined = resale ? "montagem" : destination;
  const placa = selected.find((m) => m.item === PLACA_ITEM);
  const complete = isMaintenanceComplete(selected);
  // Ou marca as manutenções feitas, ou diz que nenhuma foi executada.
  const chosen = none || selected.length > 0;

  let warn: string | null = null;
  if (!complete) warn = "Informe o serviço feito na placa para concluir.";
  else if (!chosen) warn = 'Marque as manutenções feitas ou "Nenhuma manutenção executada".';
  else if (resale === undefined) warn = "Informe se o aparelho vai para revenda.";
  else if (!choice) warn = "Escolha para onde o aparelho vai.";

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="maintenance-title"
      // Esc ou clique fora não concluem nada: só fecham a pergunta.
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="maintenance-title" className={styles.title}>
        Manutenções realizadas
      </h2>
      <p className={styles.help}>{rejected
          ? "Checklist com falha. Marque as manutenções feitas (ou nenhuma) e diga para onde o aparelho vai."
          : "Marque o que foi feito neste aparelho, ou marque que nenhuma manutenção foi executada."}</p>
      {faceIdDefect && (
        <p className={styles.notice}>
          Face ID com defeito: o aparelho não é reprovado. Ele segue para a montagem e depois para laudo e revenda, ou você pode enviá-lo para análise técnica.
        </p>
      )}

      <label className={[styles.option, styles.none].join(" ")}>
        <input
          type="checkbox"
          checked={none}
          disabled={busy}
          onChange={(e) => {
            setNone(e.target.checked);
            if (e.target.checked) setSelected([]);
          }}
        />
        <span>Nenhuma manutenção executada</span>
      </label>

      <div className={styles.grid}>
        {MAINTENANCE_ITEMS.map((item) => (
          <label key={item} className={styles.option}>
            <input
              type="checkbox"
              checked={selected.some((m) => m.item === item)}
              disabled={busy}
              onChange={() => {
                setNone(false);
                setSelected((prev) => toggleMaintenance(prev, item));
              }}
            />
            <span>{item}</span>
          </label>
        ))}
      </div>

      {placa && (
        <label className={styles.detail}>
          Qual manutenção foi feita na placa?
          {PLACA_SERVICES.length ? (
            <select
              value={placa.detail ?? ""}
              disabled={busy}
              onChange={(e) => setSelected((prev) => setMaintenanceDetail(prev, PLACA_ITEM, e.target.value))}
            >
              <option value="">Selecione…</option>
              {PLACA_SERVICES.map((service) => (
                <option key={service} value={service}>
                  {service}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={placa.detail ?? ""}
              maxLength={120}
              disabled={busy}
              placeholder="Descreva o serviço feito na placa"
              onChange={(e) => setSelected((prev) => setMaintenanceDetail(prev, PLACA_ITEM, e.target.value))}
            />
          )}
        </label>
      )}

      <label className={[styles.option, styles.none].join(" ")}>
        <input type="checkbox" checked={blocked} disabled={busy} onChange={(e) => setBlocked(e.target.checked)} />
        <span>Ativo bloqueado</span>
      </label>

      <fieldset className={styles.destination} disabled={busy}>
        <legend>Aparelho vai para revenda?</legend>
        {[
          { label: "Sim", value: true },
          { label: "Não", value: false },
        ].map((option) => (
          <label key={option.label} className={styles.option}>
            <input type="radio" name="resale" checked={resale === option.value} onChange={() => setResale(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      {resale && <p className={styles.help}>Revenda: o aparelho segue para a montagem automaticamente.</p>}
      <fieldset className={styles.destination} disabled={busy || Boolean(resale)}>
        <legend>Para onde o aparelho vai?</legend>
        {destinations.map(({ id, label }) => (
          <label key={id} className={styles.option}>
            <input type="radio" name="destination" checked={choice === id} onChange={() => setDestination(id)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      {!rejected && (
        <p className={styles.help}>
          Só "Liberado para montagem" tira o aparelho da manutenção. Enviado para vidro ou para análise técnica, ele continua em manutenção.
        </p>
      )}

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
        <Button
          onClick={() => onConfirm(selected, choice === STAYS ? undefined : choice, blocked, resale)}
          disabled={busy || Boolean(warn)}
        >
          {busy ? "Concluindo…" : "Concluir checklist"}
        </Button>
      </div>
      {warn && <p className={styles.warn}>{warn}</p>}
    </dialog>
  );
}
