import { useEffect, useRef, useState } from "react";
import {
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
  onConfirm: (maintenances: Maintenance[], destination: Destination) => void;
}

/** Aparece ao concluir um checklist com tudo OK: quais manutenções foram feitas no aparelho. */
export function MaintenanceDialog({ open, busy = false, onCancel, onConfirm }: MaintenanceDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<Maintenance[]>([]);
  const [destination, setDestination] = useState<Destination | undefined>();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setSelected([]);
      setDestination(undefined);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const placa = selected.find((m) => m.item === PLACA_ITEM);
  const complete = isMaintenanceComplete(selected);

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
      <p className={styles.help}>Marque o que foi feito neste aparelho. Se nada foi feito, deixe em branco.</p>

      <div className={styles.grid}>
        {MAINTENANCE_ITEMS.map((item) => (
          <label key={item} className={styles.option}>
            <input
              type="checkbox"
              checked={selected.some((m) => m.item === item)}
              disabled={busy}
              onChange={() => setSelected((prev) => toggleMaintenance(prev, item))}
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

      <fieldset className={styles.destination} disabled={busy}>
        <legend>Para onde o aparelho vai?</legend>
        {DESTINATIONS.map(({ id, label }) => (
          <label key={id} className={styles.option}>
            <input type="radio" name="destination" checked={destination === id} onChange={() => setDestination(id)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <p className={styles.help}>
        Só "Liberado para montagem" tira o aparelho da manutenção. Enviado para vidro, ele continua em manutenção.
      </p>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
        <Button onClick={() => destination && onConfirm(selected, destination)} disabled={busy || !complete || !destination}>
          {busy ? "Concluindo…" : "Concluir checklist"}
        </Button>
      </div>
      {!complete && <p className={styles.warn}>Informe o serviço feito na placa para concluir.</p>}
      {complete && !destination && <p className={styles.warn}>Escolha para onde o aparelho vai.</p>}
    </dialog>
  );
}
