import { useState, type ClipboardEvent, type FormEvent } from "react";
import { splitAssetId } from "../../domain/device";
import { OUTCOME_LABELS } from "../../domain/repairChecklist";
import { describeRepairError } from "../../domain/repairStages";
import { assetsBySerial } from "../../services/supabase/stockBoardService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchReprovados, type ReprovadoRow } from "../../services/supabase/repairService";
import { Button } from "../Button/Button";
import quarantineStyles from "../QuarantinePanel/QuarantinePanel.module.css";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import { useToast } from "../Toast/ToastProvider";
import styles from "./ReprovadosPanel.module.css";

interface Entry {
  serial: string;
  unit: string | null;
}

const MAX_SERIALS = 500;
const CHUNK = 100;

/** Separa o que foi colado ou bipado: um serial por linha, ou separados por espaço, tabulação, vírgula ou ponto e vírgula. */
const splitSerials = (text: string) => text.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);

const dash = (value: string | null) => value || "—";
const outcomeLabel = (outcome: string | null) =>
  outcome && outcome in OUTCOME_LABELS ? OUTCOME_LABELS[outcome as keyof typeof OUTCOME_LABELS] : "—";
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";

const emptyRow = (serial: string): ReprovadoRow => ({
  serial,
  osNumber: null,
  outcome: null,
  finishedAt: null,
  responsavel: null,
  desmontagem: null,
  checklist: null,
  manutencao: null,
  placa: null,
  montagem: null,
  quarentena: null,
  quarentenaPor: null,
  quarentenaEm: null,
  feitas: null,
  feitasQtd: null,
});

/**
 * Reprovados: bipa vários seriais de uma vez (como na Quarentena) e, ao concluir, mostra por aparelho o técnico
 * responsável e quem fez a desmontagem, o checklist, a manutenção e a montagem.
 */
export function ReprovadosPanel({ client }: { client: AppSupabaseClient }) {
  const toast = useToast();
  const [serial, setSerial] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReprovadoRow[] | null>(null);

  // Vários de uma vez (colados da planilha, por exemplo) ou um bipado: repetidos são ignorados.
  const addMany = async (values: string[]) => {
    const known = new Set(entries.map((entry) => entry.serial.toLowerCase()));
    const fresh: string[] = [];
    for (const value of values) {
      const key = value.toLowerCase();
      if (known.has(key)) continue;
      known.add(key);
      fresh.push(value);
    }
    const room = Math.max(0, MAX_SERIALS - entries.length);
    const accepted = fresh.slice(0, room);
    if (!accepted.length) {
      if (values.length) toast(fresh.length ? `A lista aceita até ${MAX_SERIALS} seriais.` : "Esses seriais já estão na lista.");
      return;
    }
    // Aparecem na hora; o modelo e a unidade entram em seguida.
    setEntries((prev) => [...prev, ...accepted.filter((value) => !prev.some((entry) => entry.serial.toLowerCase() === value.toLowerCase())).map((value) => ({ serial: value, unit: null }))]);
    const units = new Map<string, string>();
    for (let i = 0; i < accepted.length; i += CHUNK) {
      const found = await assetsBySerial(client, accepted.slice(i, i + CHUNK)).catch(() => null);
      found?.forEach((asset, key) => units.set(key, asset.unit));
    }
    if (units.size) setEntries((prev) => prev.map((entry) => (entry.unit ? entry : { ...entry, unit: units.get(entry.serial.toLowerCase()) ?? null })));
    const skipped = values.length - accepted.length;
    if (values.length > 1) toast(`${accepted.length} seriais adicionados${skipped ? ` (${skipped} repetidos ou acima do limite ignorados)` : ""}`);
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const values = splitSerials(serial);
    setSerial("");
    if (values.length) await addMany(values);
  };

  // Colar uma lista inteira (várias linhas) adiciona todos os seriais de uma vez.
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const values = splitSerials(event.clipboardData.getData("text"));
    if (values.length < 2) return;
    event.preventDefault();
    setSerial("");
    void addMany(values);
  };

  const conclude = async () => {
    if (!entries.length) return;
    setBusy(true);
    try {
      const found = await fetchReprovados(
        client,
        entries.map((entry) => entry.serial),
      );
      // Na ordem em que foram bipados; serial sem retorno aparece vazio.
      const byKey = new Map(found.map((row) => [row.serial.trim().toLowerCase(), row]));
      setResult(entries.map((entry) => byKey.get(entry.serial.trim().toLowerCase()) ?? emptyRow(entry.serial)));
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível buscar os responsáveis. Tente de novo."));
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setResult(null);
    setEntries([]);
  };

  const unitOf = (serialValue: string) => entries.find((entry) => entry.serial === serialValue)?.unit ?? null;

  return (
    <section className={recordStyles.panel} aria-label="Reprovados">
      <div className={recordStyles.header}>
        <h2>Reprovados</h2>
      </div>

      {result ? (
        <>
          <p className={quarantineStyles.pendingNote}>
            Quem fez cada etapa de {result.length} aparelho(s), na OS mais recente de cada um. “—” quer dizer que a etapa não tem registro.
          </p>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>OS</th>
                  <th>Técnico responsável</th>
                  <th>Desmontagem</th>
                  <th>Checklist</th>
                  <th>Manutenção</th>
                  <th>Manutenções feitas</th>
                  <th>Montagem</th>
                  <th>Quarentena</th>
                </tr>
              </thead>
              <tbody>
                {result.map((row) => {
                  const unit = unitOf(row.serial);
                  return (
                    <tr key={row.serial}>
                      <td>
                        <strong>{row.serial}</strong>
                        {unit && (
                          <small>
                            {splitAssetId(unit).model} · {splitAssetId(unit).code || unit}
                          </small>
                        )}
                      </td>
                      <td>
                        {row.osNumber ?? "Sem OS"}
                        {row.outcome && <small>{outcomeLabel(row.outcome)}</small>}
                      </td>
                      <td>{dash(row.responsavel)}</td>
                      <td>{dash(row.desmontagem)}</td>
                      <td>{dash(row.checklist)}</td>
                      <td>
                        {dash(row.manutencao)}
                        {row.placa && <small>Placa: {row.placa}</small>}
                      </td>
                      <td>
                        {row.feitas ? row.feitas : "—"}
                        {row.feitasQtd ? (
                          <small>
                            {row.feitasQtd} {row.feitasQtd === 1 ? "manutenção" : "manutenções"}
                          </small>
                        ) : null}
                      </td>
                      <td>{dash(row.montagem)}</td>
                      <td>
                        {row.quarentena ? (row.quarentena === "reprovado" ? "Reprovado" : "Aprovado") : "—"}
                        {row.quarentenaPor && (
                          <small>
                            {row.quarentenaPor} · {when(row.quarentenaEm)}
                          </small>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={quarantineStyles.footer}>
            <span />
            <Button onClick={restart}>Nova lista</Button>
          </div>
        </>
      ) : (
        <>
          <form className={quarantineStyles.form} onSubmit={(e) => void add(e)}>
            <label className={quarantineStyles.serial}>
              Serial
              <input
                value={serial}
                onChange={(e) => setSerial(e.target.value)}
                onPaste={paste}
                placeholder="Bipe o serial e aperte Enter, ou cole vários de uma vez"
                autoComplete="off"
                autoFocus
                disabled={busy}
              />
            </label>
          </form>

          {entries.length ? (
            <ul className={quarantineStyles.list}>
              {entries.map((entry) => (
                <li key={entry.serial} className={quarantineStyles.item}>
                  <span className={quarantineStyles.itemSerial}>
                    {entry.serial}
                    {entry.unit && (
                      <small>
                        {splitAssetId(entry.unit).model} · {splitAssetId(entry.unit).code || entry.unit}
                      </small>
                    )}
                  </span>
                  <Button variant="small" disabled={busy} onClick={() => setEntries((prev) => prev.filter((other) => other.serial !== entry.serial))}>
                    Remover
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={recordStyles.empty}>Nenhum serial bipado.</div>
          )}

          <div className={quarantineStyles.footer}>
            <span>{entries.length} na lista</span>
            <Button onClick={() => void conclude()} disabled={busy || !entries.length}>
              {busy ? "Buscando…" : "Concluir"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
