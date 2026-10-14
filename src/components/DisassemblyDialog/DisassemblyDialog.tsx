import { useEffect, useRef, useState } from "react";
import {
  DISASSEMBLY_DESTINATIONS,
  isMaintenanceComplete,
  MAINTENANCE_ITEMS,
  PLACA_ITEM,
  PLACA_SERVICES,
  setMaintenanceDetail,
  TECHNICAL_DISASSEMBLY_DESTINATIONS,
  toggleMaintenance,
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
  /** Desmontagem técnica: aparelho com consumo na fonte de bancada e a observação. */
  consumption?: boolean;
  consumptionNote?: string;
  /** Desmontagem técnica: peças trocadas na desmontagem. */
  parts?: Maintenance[];
  /** Desmontagem técnica: peças que precisam ser trocadas. */
  neededParts?: Maintenance[];
  /** Desmontagem técnica: marcado como PT e a observação. */
  pt?: boolean;
  ptNote?: string;
}

interface DisassemblyDialogProps {
  open: boolean;
  busy?: boolean;
  /** Desmontagem técnica: consumo, troca de peças, peças necessárias e PT. */
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

function NoteField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.detail}>
      {label}
      <textarea value={value} maxLength={500} rows={2} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** Caixa de seleção das manutenções/peças; com `withPlaca`, a placa pede o serviço feito. */
function PartsPicker({
  selected,
  disabled,
  withPlaca = false,
  onChange,
}: {
  selected: Maintenance[];
  disabled: boolean;
  withPlaca?: boolean;
  onChange: (next: Maintenance[]) => void;
}) {
  const placa = withPlaca ? selected.find((m) => m.item === PLACA_ITEM) : undefined;
  return (
    <>
      <div className={styles.grid}>
        {MAINTENANCE_ITEMS.map((item) => (
          <label key={item} className={styles.option}>
            <input
              type="checkbox"
              checked={selected.some((m) => m.item === item)}
              disabled={disabled}
              onChange={() => onChange(toggleMaintenance(selected, item))}
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
              disabled={disabled}
              onChange={(e) => onChange(setMaintenanceDetail(selected, PLACA_ITEM, e.target.value))}
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
              disabled={disabled}
              placeholder="Descreva o serviço feito na placa"
              onChange={(e) => onChange(setMaintenanceDetail(selected, PLACA_ITEM, e.target.value))}
            />
          )}
        </label>
      )}
    </>
  );
}

/** Aparece ao concluir a desmontagem (ou a desmontagem técnica): perguntas e direcionamento do aparelho. */
export function DisassemblyDialog({ open, busy = false, technical = false, onCancel, onConfirm }: DisassemblyDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [highLid, setHighLid] = useState<YesNo>();
  const [blocked, setBlocked] = useState<YesNo>();
  const [consumption, setConsumption] = useState<YesNo>();
  const [consumptionNote, setConsumptionNote] = useState("");
  const [replaced, setReplaced] = useState<YesNo>();
  const [parts, setParts] = useState<Maintenance[]>([]);
  const [needed, setNeeded] = useState<YesNo>();
  const [neededParts, setNeededParts] = useState<Maintenance[]>([]);
  const [pt, setPt] = useState<YesNo>();
  const [ptNote, setPtNote] = useState("");
  const [destination, setDestination] = useState<Destination | undefined>();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setHighLid(undefined);
      setBlocked(undefined);
      setConsumption(undefined);
      setConsumptionNote("");
      setReplaced(undefined);
      setParts([]);
      setNeeded(undefined);
      setNeededParts([]);
      setPt(undefined);
      setPtNote("");
      setDestination(undefined);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  // Marcado como PT, o aparelho é enviado para PT automaticamente.
  const chosen: Destination | undefined = technical && pt ? "pt" : destination;
  const destinations = technical ? TECHNICAL_DISASSEMBLY_DESTINATIONS : DISASSEMBLY_DESTINATIONS;

  let warn: string | null = null;
  if (technical) {
    if (consumption === undefined) warn = "Informe se o aparelho tem consumo.";
    else if (consumption && !consumptionNote.trim()) warn = "Escreva a observação do consumo.";
    else if (replaced === undefined) warn = "Informe se a desmontagem trocou alguma peça.";
    else if (replaced && parts.length === 0) warn = "Marque as peças trocadas.";
    else if (!isMaintenanceComplete(parts)) warn = "Informe o serviço feito na placa.";
    else if (needed === undefined) warn = "Informe se é necessário trocar alguma peça.";
    else if (needed && neededParts.length === 0) warn = "Marque as peças que precisam ser trocadas.";
  } else if (highLid === undefined) {
    warn = "Informe se o aparelho tem tampa ou tela alta.";
  }
  if (!warn && blocked === undefined) warn = "Informe se o aparelho está bloqueado.";
  if (!warn && technical && pt === undefined) warn = "Informe se o aparelho é PT.";
  if (!warn && technical && pt && !ptNote.trim()) warn = "Escreva a observação do PT.";
  if (!warn && !chosen) warn = "Escolha para onde o aparelho vai.";

  const confirm = () => {
    if (warn || !chosen) return;
    onConfirm({
      destination: chosen,
      blocked: Boolean(blocked),
      ...(technical
        ? {
            consumption: Boolean(consumption),
            consumptionNote: consumption ? consumptionNote.trim() : undefined,
            parts: replaced ? parts : [],
            neededParts: needed ? neededParts : [],
            pt: Boolean(pt),
            ptNote: pt ? ptNote.trim() : undefined,
          }
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
          <YesNoField legend="Aparelho com consumo?" name="disassembly-consumption" value={consumption} disabled={busy} onChange={setConsumption} />
          {consumption && <NoteField label="Observação do consumo" value={consumptionNote} disabled={busy} onChange={setConsumptionNote} />}

          <YesNoField
            legend="Desmontagem trocou alguma peça?"
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
              <PartsPicker selected={parts} disabled={busy} withPlaca onChange={setParts} />
            </>
          )}

          <YesNoField
            legend="Ainda necessita troca de peça?"
            name="disassembly-needed"
            value={needed}
            disabled={busy}
            onChange={(value) => {
              setNeeded(value);
              if (!value) setNeededParts([]);
            }}
          />
          {needed && (
            <>
              <p className={styles.help}>Marque as peças que precisam ser trocadas.</p>
              <PartsPicker selected={neededParts} disabled={busy} onChange={setNeededParts} />
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

      <YesNoField legend="Aparelho bloqueado?" name="disassembly-blocked" value={blocked} disabled={busy} onChange={setBlocked} />

      {technical && (
        <>
          <YesNoField legend="PT?" name="disassembly-pt" value={pt} disabled={busy} onChange={setPt} />
          {pt && <NoteField label="Observação do PT" value={ptNote} disabled={busy} onChange={setPtNote} />}
        </>
      )}

      <fieldset className={styles.destination} disabled={busy || Boolean(technical && pt)}>
        <legend>Para onde o aparelho vai?{technical && pt ? " (PT: enviado para PT)" : ""}</legend>
        {destinations.map(({ id, label }) => (
          <label key={id} className={styles.option}>
            <input type="radio" name="disassembly-destination" checked={chosen === id} onChange={() => setDestination(id)} />
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
