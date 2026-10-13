import { useState, type FormEvent } from "react";
import { splitAssetId } from "../../domain/device";
import { lookupAsset } from "../../services/supabase/assetsService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  registerQuarantine,
  type QuarantineEntry,
  type QuarantineResult,
} from "../../services/supabase/quarantineService";
import { Button } from "../Button/Button";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import { useToast } from "../Toast/ToastProvider";
import styles from "./QuarantinePanel.module.css";

interface QuarantinePanelProps {
  client: AppSupabaseClient;
  userId: string;
}

const RESULTS: { id: QuarantineResult; label: string }[] = [
  { id: "aprovado", label: "Aprovado" },
  { id: "reprovado", label: "Reprovado" },
];

/** Quarentena: bipa vários seriais, marca aprovado ou reprovado e registra todos de uma vez. */
export function QuarantinePanel({ client, userId }: QuarantinePanelProps) {
  const toast = useToast();
  const [serial, setSerial] = useState("");
  const [result, setResult] = useState<QuarantineResult>("aprovado");
  const [entries, setEntries] = useState<QuarantineEntry[]>([]);
  const [saving, setSaving] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const value = serial.trim();
    if (!value) return;
    setSerial("");
    const key = value.toLowerCase();
    // Bipar de novo um serial da lista só troca o resultado dele.
    if (entries.some((entry) => entry.serial.toLowerCase() === key)) {
      setEntries((prev) => prev.map((entry) => (entry.serial.toLowerCase() === key ? { ...entry, result } : entry)));
      return;
    }
    const unit = await lookupAsset(client, value)
      .then((asset) => asset?.assetShortId ?? null)
      .catch(() => null);
    setEntries((prev) =>
      prev.some((entry) => entry.serial.toLowerCase() === key) ? prev : [...prev, { serial: value, result, unit }],
    );
  };

  const setEntryResult = (serialValue: string, next: QuarantineResult) =>
    setEntries((prev) => prev.map((entry) => (entry.serial === serialValue ? { ...entry, result: next } : entry)));

  const approved = entries.filter((entry) => entry.result === "aprovado").length;
  const rejected = entries.length - approved;

  const save = async () => {
    if (!entries.length || !userId) return;
    setSaving(true);
    try {
      await registerQuarantine(client, entries);
      toast(`Quarentena registrada: ${approved} aprovados, ${rejected} reprovados`);
      setEntries([]);
    } catch {
      toast("Não foi possível registrar. Tente de novo.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={recordStyles.panel} aria-label="Quarentena">
      <div className={recordStyles.header}>
        <h2>Quarentena</h2>
      </div>
      <form className={styles.form} onSubmit={(e) => void add(e)}>
        <label className={styles.serial}>
          Serial
          <input
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="Bipe o serial e aperte Enter"
            autoComplete="off"
            autoFocus
            disabled={saving}
          />
        </label>
        <fieldset className={styles.results} disabled={saving}>
          <legend>Resultado</legend>
          {RESULTS.map(({ id, label }) => (
            <label key={id} className={styles.option}>
              <input type="radio" name="quarantine-result" checked={result === id} onChange={() => setResult(id)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      </form>

      {entries.length ? (
        <ul className={styles.list}>
          {entries.map((entry) => (
            <li key={entry.serial} className={styles.item}>
              <span className={styles.itemSerial}>
                {entry.serial}
                {entry.unit && (
                  <small>
                    {splitAssetId(entry.unit).model} · {splitAssetId(entry.unit).code || entry.unit}
                  </small>
                )}
              </span>
              <span className={styles.itemResults}>
                {RESULTS.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    className={styles.pick}
                    data-result={id}
                    aria-pressed={entry.result === id}
                    disabled={saving}
                    onClick={() => setEntryResult(entry.serial, id)}
                  >
                    {label}
                  </button>
                ))}
              </span>
              <Button
                variant="small"
                disabled={saving}
                onClick={() => setEntries((prev) => prev.filter((other) => other.serial !== entry.serial))}
              >
                Remover
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className={recordStyles.empty}>Nenhum serial bipado.</div>
      )}

      <div className={styles.footer}>
        <span>
          {entries.length} bipados · {approved} aprovados · {rejected} reprovados
        </span>
        <Button onClick={() => void save()} disabled={saving || !entries.length}>
          {saving ? "Registrando…" : "Registrar quarentena"}
        </Button>
      </div>
    </section>
  );
}
