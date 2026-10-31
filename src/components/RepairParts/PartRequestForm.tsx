import { useState } from "react";
import { batchMessage, describeRepairError, type RequestPurpose } from "../../domain/repairStages";
import { STOCK_PARTS } from "../../domain/stock";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { createRequest } from "../../services/supabase/repairService";
import { Button } from "../Button/Button";
import { useToast } from "../Toast/ToastProvider";
import styles from "./RepairParts.module.css";

interface PartRequestFormProps {
  client: AppSupabaseClient;
  serial: string;
  disabled?: boolean;
  /** Depois de enviar: a tela recarrega as solicitações e o cronômetro (que pausa sozinho). */
  onSent: () => void;
}

/** Solicitação de peças: marque quantas quiser de uma vez. Teste: uma unidade por tipo; definitiva: quantidade por peça. */
export function PartRequestForm({ client, serial, disabled = false, onSent }: PartRequestFormProps) {
  const toast = useToast();
  const [purpose, setPurpose] = useState<RequestPurpose>("teste");
  // Peças marcadas e a quantidade de cada uma (a quantidade só vale na definitiva).
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const parts = Object.keys(selected);

  const toggle = (part: string) =>
    setSelected((prev) => {
      const next = { ...prev };
      if (part in next) delete next[part];
      else next[part] = 1;
      return next;
    });

  const setQty = (part: string, qty: number) => setSelected((prev) => ({ ...prev, [part]: Math.min(99, Math.max(1, qty || 1)) }));

  const send = async () => {
    if (!parts.length || busy) return;
    setBusy(true);
    const failed: { part: string; message: string }[] = [];
    let sent = 0;
    // Uma a uma: cada peça é uma solicitação própria, e uma recusada (ex.: teste repetido) não derruba as outras.
    for (const part of parts) {
      try {
        await createRequest(client, { serial, part, purpose, qty: purpose === "teste" ? 1 : (selected[part] ?? 1) });
        sent += 1;
        setSelected((prev) => {
          const next = { ...prev };
          delete next[part];
          return next;
        });
      } catch (error) {
        failed.push({ part, message: describeRepairError(error as { code?: string; message?: string }, "não foi possível solicitar") });
      }
    }
    setBusy(false);
    toast(batchMessage(sent, failed));
    if (sent) onSent();
  };

  return (
    <fieldset className={styles.form} disabled={disabled || busy}>
      <legend>Solicitar peças</legend>
      <div className={styles.purposes} role="radiogroup" aria-label="Finalidade">
        {(["teste", "definitiva"] as const).map((value) => (
          <label key={value} className={[styles.purpose, purpose === value ? styles.purposeOn : ""].join(" ")}>
            <input type="radio" name="purpose" checked={purpose === value} onChange={() => setPurpose(value)} />
            <span>{value === "teste" ? "Peça de teste" : "Peça definitiva"}</span>
          </label>
        ))}
      </div>
      <p className={styles.note}>
        {purpose === "teste"
          ? "Marque todas as peças que quiser testar: uma unidade de cada tipo."
          : "Marque as peças e informe a quantidade de cada uma."}
      </p>
      <div className={styles.parts}>
        {STOCK_PARTS.map((part) => {
          const on = part in selected;
          return (
            <div key={part} className={[styles.partChip, on ? styles.partOn : ""].join(" ")}>
              <label>
                <input type="checkbox" checked={on} onChange={() => toggle(part)} />
                <span>{part}</span>
              </label>
              {on && purpose === "definitiva" && (
                <input
                  type="number"
                  className={styles.qtyInput}
                  min={1}
                  max={99}
                  value={selected[part]}
                  aria-label={`Quantidade de ${part}`}
                  onChange={(e) => setQty(part, Number(e.target.value))}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className={styles.send}>
        <Button onClick={() => void send()} disabled={!parts.length}>
          {busy ? "Enviando…" : parts.length > 1 ? `Solicitar ${parts.length} peças` : "Solicitar"}
        </Button>
        {parts.length > 0 && !busy && (
          <Button variant="ghost" onClick={() => setSelected({})}>
            Limpar
          </Button>
        )}
      </div>
    </fieldset>
  );
}
