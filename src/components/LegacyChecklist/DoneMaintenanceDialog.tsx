import { useEffect, useRef, useState } from "react";
import { MAINTENANCE_ITEMS } from "../../domain/maintenance";
import { Button } from "../Button/Button";
import styles from "../MaintenanceDialog/MaintenanceDialog.module.css";

/** O que o técnico informou: nome da manutenção e quantas. */
export interface DoneItem {
  nome: string;
  qtd: number;
}

// Peças e serviços possíveis: o catálogo de manutenções (inclui Placa e Limpeza).
const OPTIONS: readonly string[] = MAINTENANCE_ITEMS;

interface DoneMaintenanceDialogProps {
  open: boolean;
  busy?: boolean;
  serial: string;
  /** Para onde o aparelho vai (texto do destino escolhido). */
  destination: string;
  onCancel: () => void;
  onConfirm: (items: DoneItem[]) => void;
}

/**
 * Balão ao finalizar o checklist manutenção (com vidro ou sem): o técnico marca as manutenções que fez, com a
 * quantidade, e vê o total. Elas contam para ele e aparecem na aba Reprovados.
 */
export function DoneMaintenanceDialog({ open, busy = false, serial, destination, onCancel, onConfirm }: DoneMaintenanceDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<Record<string, number>>({});
  // Resposta explícita de que nenhuma manutenção foi feita (ex.: só vidro).
  const [none, setNone] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setSelected({});
      setNone(false);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const items = OPTIONS.filter((name) => selected[name]).map((name) => ({ nome: name, qtd: selected[name] as number }));
  const total = items.reduce((sum, item) => sum + item.qtd, 0);
  const ready = total > 0 || none;

  const toggle = (name: string) => {
    setNone(false);
    setSelected((prev) => {
      const next = { ...prev };
      if (next[name]) delete next[name];
      else next[name] = 1;
      return next;
    });
  };
  const setQty = (name: string, qty: number) => setSelected((prev) => ({ ...prev, [name]: Math.min(99, Math.max(1, qty || 1)) }));

  return (
    <dialog ref={dialog} className={styles.dialog} onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }} aria-labelledby="done-maintenance-title">
      <h2 id="done-maintenance-title" className={styles.title}>
        Manutenções feitas em {serial}
      </h2>
      <p className={styles.help}>
        Marque o que você fez neste aparelho e a quantidade. Cada uma conta como uma manutenção para você. Destino: <strong>{destination}</strong>.
      </p>

      <div className={styles.grid}>
        {OPTIONS.map((name) => (
          <label key={name} className={styles.option}>
            <input type="checkbox" checked={Boolean(selected[name])} disabled={busy} onChange={() => toggle(name)} />
            <span>{name}</span>
            {selected[name] ? (
              <input
                type="number"
                min={1}
                max={99}
                value={selected[name]}
                disabled={busy}
                aria-label={`Quantidade de ${name}`}
                style={{ width: 56, marginLeft: "auto" }}
                onChange={(e) => setQty(name, Number(e.target.value))}
              />
            ) : null}
          </label>
        ))}
      </div>

      <label className={styles.option}>
        <input
          type="checkbox"
          checked={none}
          disabled={busy || total > 0}
          onChange={(e) => setNone(e.target.checked)}
        />
        <span>Nenhuma manutenção foi feita</span>
      </label>

      <p className={styles.help} role="status">
        <strong>{total}</strong> {total === 1 ? "manutenção" : "manutenções"}
        {items.length ? `: ${items.map((item) => (item.qtd > 1 ? `${item.nome} (${item.qtd})` : item.nome)).join(", ")}` : ""}
      </p>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Voltar
        </Button>
        <Button disabled={busy || !ready} onClick={() => onConfirm(items)}>
          {busy ? "Finalizando…" : "Finalizar checklist"}
        </Button>
      </div>
    </dialog>
  );
}
