import { useCallback, useEffect, useState, type FormEvent } from "react";
import { MAINTENANCE_ITEMS } from "../../domain/maintenance";
import { describeRepairError } from "../../domain/repairStages";
import { assetsBySerial } from "../../services/supabase/stockBoardService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchMyIncorrectDefects, registerIncorrectDefect, type IncorrectDefectMine } from "../../services/supabase/incorrectDefectService";
import { Button } from "../Button/Button";
import quarantineStyles from "../QuarantinePanel/QuarantinePanel.module.css";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import { useToast } from "../Toast/ToastProvider";
import styles from "./IncorrectDefectPanel.module.css";

const when = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/**
 * Defeito incorreto: bipa o ativo e marca a peça (ou as peças) cujo defeito não foi identificado/relatado. Cada registro
 * guarda quem identificou; a Análise mostra quantos ativos tiveram divergência, quem identificou e qual defeito faltou.
 */
export function IncorrectDefectPanel({ client }: { client: AppSupabaseClient }) {
  const toast = useToast();
  const [serial, setSerial] = useState("");
  const [asset, setAsset] = useState<{ serial: string; unit: string | null; model: string | null; found: boolean | null } | null>(null);
  const [parts, setParts] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<IncorrectDefectMine[] | null>(null);

  const reload = useCallback(() => {
    fetchMyIncorrectDefects(client)
      .then(setMine)
      .catch(() => setMine((current) => current ?? []));
  }, [client]);
  useEffect(reload, [reload]);

  const lookup = async (event: FormEvent) => {
    event.preventDefault();
    const value = serial.trim();
    if (!value) return;
    setSerial("");
    setParts([]);
    setNote("");
    setAsset({ serial: value, unit: null, model: null, found: null });
    const found = await assetsBySerial(client, [value]).catch(() => null);
    const info = found?.get(value.toLowerCase()) ?? null;
    setAsset((current) =>
      current && current.serial === value ? { serial: value, unit: info?.unit ?? null, model: info?.model ?? null, found: found ? Boolean(info) : null } : current,
    );
  };

  const toggle = (name: string) => setParts((prev) => (prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]));

  const save = async () => {
    if (!asset || !parts.length) return;
    setBusy(true);
    try {
      await registerIncorrectDefect(client, asset.serial, parts, note.trim() || null);
      toast(`Registrado em ${asset.serial}: ${parts.join(", ")}`);
      setAsset(null);
      setParts([]);
      setNote("");
      reload();
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível registrar. Tente de novo."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={recordStyles.panel} aria-label="Defeito incorreto">
      <div className={recordStyles.header}>
        <h2>Defeito incorreto</h2>
      </div>
      <p className={quarantineStyles.pendingNote}>
        Bipe o ativo e marque a peça cujo defeito <strong>não foi identificado</strong> (não foi relatado). O registro fica com o seu nome.
      </p>

      <form className={quarantineStyles.form} onSubmit={(e) => void lookup(e)}>
        <label className={quarantineStyles.serial}>
          Serial
          <input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="Bipe o serial e aperte Enter" autoComplete="off" autoFocus disabled={busy} />
        </label>
      </form>

      {asset && (
        <div className={styles.box}>
          <dl className={styles.info}>
            <div>
              <dt>Serial</dt>
              <dd>{asset.serial}</dd>
            </div>
            <div>
              <dt>Modelo</dt>
              <dd>{asset.found === null ? "…" : (asset.model ?? "—")}</dd>
            </div>
            <div>
              <dt>Unit ID</dt>
              <dd>{asset.found === null ? "…" : (asset.unit ?? "—")}</dd>
            </div>
          </dl>
          {asset.found === false && <p className={styles.help}>Serial não encontrado na planilha de ativos. Confira se foi bipado certo.</p>}
          <p className={styles.help}>Qual peça estava com defeito e não foi identificada?</p>
          <div className={styles.grid}>
            {MAINTENANCE_ITEMS.map((name) => (
              <label key={name} className={styles.option}>
                <input type="checkbox" checked={parts.includes(name)} disabled={busy} onChange={() => toggle(name)} />
                <span>{name}</span>
              </label>
            ))}
          </div>
          <label className={styles.note}>
            Observação (opcional)
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} disabled={busy} placeholder="Ex.: bateria com ciclo alto, relatado só tela" />
          </label>
          <div className={styles.actions}>
            <Button variant="ghost" disabled={busy} onClick={() => setAsset(null)}>
              Cancelar
            </Button>
            <Button disabled={busy || !parts.length} onClick={() => void save()}>
              {busy ? "Salvando…" : `Registrar${parts.length ? ` (${parts.length})` : ""}`}
            </Button>
          </div>
        </div>
      )}

      <h3 className={styles.sub}>Seus registros de hoje</h3>
      {mine === null && <div className={recordStyles.empty}>Carregando…</div>}
      {mine?.length === 0 && <div className={recordStyles.empty}>Nenhum registro hoje.</div>}
      {mine && mine.length > 0 && (
        <ul className={quarantineStyles.list}>
          {mine.map((row, i) => (
            <li key={`${row.serial}-${row.part}-${row.at}-${i}`} className={quarantineStyles.item}>
              <span className={quarantineStyles.itemSerial}>
                {row.serial}
                <small>
                  {row.part}
                  {row.note ? ` · ${row.note}` : ""}
                </small>
              </span>
              <span>{when(row.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
