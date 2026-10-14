import { useEffect, useRef, useState } from "react";
import {
  BOOT_ISSUES,
  DISASSEMBLY_DESTINATIONS,
  isMaintenanceComplete,
  MAINTENANCE_ITEMS,
  PLACA_ITEM,
  PLACA_SERVICES,
  setMaintenanceDetail,
  TECHNICAL_DISASSEMBLY_DESTINATIONS,
  toggleMaintenance,
  type BootIssue,
  type Destination,
  type Maintenance,
} from "../../domain/maintenance";
import { Button } from "../Button/Button";
import styles from "../MaintenanceDialog/MaintenanceDialog.module.css";

export interface DisassemblyOutcome {
  destination: Destination;
  blocked: boolean;
  /** Desmontagem: tampa ou tela alta. */
  highLid?: boolean;
  /** Desmontagem técnica: não liga ou em looping. */
  bootIssue?: BootIssue;
  /** Desmontagem técnica: peças trocadas. */
  parts?: Maintenance[];
}

interface DisassemblyDialogProps {
  open: boolean;
  busy?: boolean;
  /** Desmontagem técnica: pergunta defeito e troca de peças, e oferece análise e PT. */
  technical?: boolean;
  onCancel: () => void;
  onConfirm: (outcome: DisassemblyOutcome) => void;
}

type YesNo = boolean | undefined;

function YesNoField({
  legend,
  name,
  value,
  disabled,
  onChange,
}: {
  legend: string;
  name: string;
  value: YesNo;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <fieldset className={styles.destination} disabled={disabled}>
      <legend>{legend}</legend>
      {[
        { label: "Sim", value: true },
        { label: "Não", value: false },
      ].map((option) => (
        <label key={option.label} className={styles.option}>
          <input type="radio" name={name} checked={value === option.value} onChange={() => onChange(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Aparece ao concluir a desmontagem (ou a desmontagem técnica): perguntas e direcionamento do aparelho. */
export function DisassemblyDialog({ open, busy = false, technical = false, onCancel, onConfirm }: DisassemblyDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [highLid, setHighLid] = useState<YesNo>();
  const [blocked, setBlocked] = useState<YesNo>();
  const [bootIssue, setBootIssue] = useState<BootIssue | "">("");
  const [replaced, setReplaced] = useState<YesNo>();
  const [parts, setParts] = useState<Maintenance[]>([]);
  const [destination, setDestination] = useState<Destination | undefined>();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setHighLid(undefined);
      setBlocked(undefined);
      setBootIssue("");
      setReplaced(undefined);
      setParts([]);
      setDestination(undefined);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const destinations = technical ? TECHNICAL_DISASSEMBLY_DESTINATIONS : DISASSEMBLY_DESTINATIONS;
  const placa = parts.find((m) => m.item === PLACA_ITEM);

  let warn: string | null = null;
  if (technical) {
    if (!bootIssue) warn = "Informe se o aparelho não liga ou está em looping.";
    else if (replaced === undefined) warn = "Informe se houve troca de peças.";
    else if (replaced && parts.length === 0) warn = "Marque as peças trocadas.";
    else if (!isMaintenanceComplete(parts)) warn = "Informe o serviço feito na placa.";
  } else if (highLid === undefined) {
    warn = "Informe se o aparelho tem tampa ou tela alta.";
  }
  if (!warn && blocked === undefined) warn = "Informe se o aparelho está bloqueado.";
  if (!warn && !destination) warn = "Escolha para onde o aparelho vai.";

  const confirm = () => {
    if (warn || !destination) return;
    onConfirm({
      destination,
      blocked: Boolean(blocked),
      ...(technical
        ? { bootIssue: bootIssue || undefined, parts: replaced ? parts : [] }
        : { highLid: Boolean(highLid) }),
    });
  };

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="disassembly-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="disassembly-title" className={styles.title}>
        {technical ? "Concluir desmontagem técnica" : "Concluir desmontagem"}
      </h2>
      <p className={styles.help}>Responda e escolha para onde o aparelho vai.</p>

      {technical ? (
        <>
          <label className={styles.detail}>
            Aparelho não liga ou em looping?
            <select value={bootIssue} disabled={busy} onChange={(e) => setBootIssue(e.target.value as BootIssue | "")}>
              <option value="">Selecione…</option>
              {BOOT_ISSUES.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <YesNoField
            legend="Houve troca de peças?"
            name="disassembly-replaced"
            value={replaced}
            disabled={busy}
            onChange={(value) => {
              setReplaced(value);
              if (!value) setParts([]);
            }}
          />
          {replaced && (
            <>
              <p className={styles.help}>Marque as peças trocadas.</p>
              <div className={styles.grid}>
                {MAINTENANCE_ITEMS.map((item) => (
                  <label key={item} className={styles.option}>
                    <input
                      type="checkbox"
                      checked={parts.some((m) => m.item === item)}
                      disabled={busy}
                      onChange={() => setParts((prev) => toggleMaintenance(prev, item))}
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
                      onChange={(e) => setParts((prev) => setMaintenanceDetail(prev, PLACA_ITEM, e.target.value))}
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
                      onChange={(e) => setParts((prev) => setMaintenanceDetail(prev, PLACA_ITEM, e.target.value))}
                    />
                  )}
                </label>
              )}
            </>
          )}
        </>
      ) : (
        <YesNoField
          legend="Aparelho com tampa ou tela alta?"
          name="disassembly-high-lid"
          value={highLid}
          disabled={busy}
          onChange={setHighLid}
        />
      )}

      <YesNoField
        legend="Aparelho bloqueado?"
        name="disassembly-blocked"
        value={blocked}
        disabled={busy}
        onChange={setBlocked}
      />

      <fieldset className={styles.destination} disabled={busy}>
        <legend>Para onde o aparelho vai?</legend>
        {destinations.map(({ id, label }) => (
          <label key={id} className={styles.option}>
            <input type="radio" name="disassembly-destination" checked={destination === id} onChange={() => setDestination(id)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
        <Button onClick={confirm} disabled={busy || Boolean(warn)}>
          {busy ? "Concluindo…" : "Concluir"}
        </Button>
      </div>
      {warn && <p className={styles.warn}>{warn}</p>}
    </dialog>
  );
}
