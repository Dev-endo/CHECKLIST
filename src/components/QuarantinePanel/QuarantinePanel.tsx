import { useEffect, useState, type FormEvent } from "react";
import { splitAssetId } from "../../domain/device";
import { lookupAsset } from "../../services/supabase/assetsService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  fetchQuarantineDaily,
  fetchQuarantinePending,
  registerQuarantine,
  type PendingQuarantine,
  type QuarantineDay,
  type QuarantineEntry,
  type QuarantineResult,
} from "../../services/supabase/quarantineService";
import { Button } from "../Button/Button";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import { useToast } from "../Toast/ToastProvider";
import styles from "./QuarantinePanel.module.css";
import { QuarantineTodayView } from "./QuarantineTodayView";

interface QuarantinePanelProps {
  client: AppSupabaseClient;
  userId: string;
  /** Aba do Reparo: mostra os aparelhos enviados pela manutenção que ainda faltam bipar. */
  showPending?: boolean;
}

const RESULTS: { id: QuarantineResult; label: string }[] = [
  { id: "aprovado", label: "Aprovado" },
  { id: "reprovado", label: "Reprovado" },
];

type View = "registrar" | "hoje" | "aguardando";

const VIEWS: readonly { id: View; label: string }[] = [
  { id: "registrar", label: "Registrar" },
  { id: "aguardando", label: "Aguardando" },
  { id: "hoje", label: "Seriais de hoje" },
];

const sentOn = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Quarentena: bipa vários seriais, marca aprovado ou reprovado e registra todos de uma vez. */
export function QuarantinePanel({ client, userId, showPending = false }: QuarantinePanelProps) {
  const toast = useToast();
  const [serial, setSerial] = useState("");
  const [result, setResult] = useState<QuarantineResult>("aprovado");
  const [entries, setEntries] = useState<QuarantineEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [days, setDays] = useState<QuarantineDay[] | "error" | null>(null);
  const [reloads, setReloads] = useState(0);
  const [view, setView] = useState<View>("registrar");
  // null enquanto carrega; só existe na aba do Reparo.
  const [pending, setPending] = useState<PendingQuarantine[] | "error" | null>(null);

  useEffect(() => {
    let active = true;
    fetchQuarantineDaily(client)
      .then((data) => active && setDays(data))
      .catch(() => active && setDays("error"));
    return () => {
      active = false;
    };
  }, [client, reloads]);

  useEffect(() => {
    if (!showPending) return;
    let active = true;
    const load = () =>
      fetchQuarantinePending(client)
        .then((data) => active && setPending(data))
        .catch(() => active && setPending("error"));
    void load();
    // Outro aparelho pode chegar da manutenção a qualquer momento.
    const poll = setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, showPending, reloads]);

  const waiting = Array.isArray(pending) ? pending : [];
  const waitingKeys = new Set(waiting.map((item) => item.serial.trim().toLowerCase()));
  const views = showPending ? VIEWS : VIEWS.filter((item) => item.id !== "aguardando");

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const value = serial.trim();
    if (!value) return;
    setSerial("");
    const key = value.toLowerCase();
    // Bipar de novo um serial da lista só troca o resultado dele.
    if (entries.some((entry) => entry.serial.toLowerCase() === key)) {
      setEntries((prev) =>
        prev.map((entry) =>
          entry.serial.toLowerCase() === key ? { ...entry, result } : entry,
        ),
      );
      return;
    }
    const unit = await lookupAsset(client, value)
      .then((asset) => asset?.assetShortId ?? null)
      .catch(() => null);
    setEntries((prev) =>
      prev.some((entry) => entry.serial.toLowerCase() === key)
        ? prev
        : [...prev, { serial: value, result, unit }],
    );
  };

  const setEntryResult = (serialValue: string, next: QuarantineResult) =>
    setEntries((prev) =>
      prev.map((entry) =>
        entry.serial === serialValue ? { ...entry, result: next } : entry,
      ),
    );

  const approved = entries.filter(
    (entry) => entry.result === "aprovado",
  ).length;
  const rejected = entries.length - approved;

  const save = async () => {
    if (!entries.length || !userId) return;
    setSaving(true);
    try {
      await registerQuarantine(client, entries);
      toast(
        `Quarentena registrada: ${approved} aprovados, ${rejected} reprovados`,
      );
      setEntries([]);
      setReloads((n) => n + 1);
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
      <div className={styles.tabs} role="tablist">
        {views.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={view === id}
            onClick={() => setView(id)}
          >
            {label}
            {id === "aguardando" && waiting.length > 0 && <span className={styles.badge}>{waiting.length}</span>}
          </button>
        ))}
      </div>
      {view === "aguardando" ? (
        <>
          <p className={styles.pendingNote}>
            Aparelhos que a manutenção enviou para a quarentena. Cada um fica aqui até o serial ser bipado e marcado como aprovado ou
            reprovado.
          </p>
          {pending === null && <div className={recordStyles.empty}>Carregando…</div>}
          {pending === "error" && <div className={recordStyles.empty}>Não foi possível carregar a lista agora.</div>}
          {Array.isArray(pending) && !pending.length && <div className={recordStyles.empty}>Nenhum aparelho aguardando a quarentena.</div>}
          <ul className={styles.list}>
            {waiting.map((item) => (
              <li key={`${item.serial}-${item.sentAt}`} className={styles.item}>
                <span className={styles.itemSerial}>
                  {item.serial}
                  <small>
                    {item.model ?? "Modelo não encontrado"}
                    {item.unit ? ` · ${splitAssetId(item.unit).code || item.unit}` : ""} · OS {item.osNumber}
                  </small>
                </span>
                <span className={styles.sent}>
                  enviado por {item.technician}
                  <small>{sentOn(item.sentAt)}</small>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : view === "hoje" ? (
        <QuarantineTodayView client={client} reloadKey={reloads} />
      ) : (
        <>
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
                  <input
                    type="radio"
                    name="quarantine-result"
                    checked={result === id}
                    onChange={() => setResult(id)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
          </form>

          {showPending && waiting.length > 0 && (
            <p className={styles.pendingNote}>
              <strong>{waiting.filter((item) => !entries.some((entry) => entry.serial.trim().toLowerCase() === item.serial.trim().toLowerCase())).length}</strong>{" "}
              aparelho(s) da manutenção ainda faltam bipar. Veja a visão Aguardando.
            </p>
          )}

          {entries.length ? (
            <ul className={styles.list}>
              {entries.map((entry) => (
                <li key={entry.serial} className={styles.item}>
                  <span className={styles.itemSerial}>
                    {entry.serial}
                    {showPending && Array.isArray(pending) && !waitingKeys.has(entry.serial.trim().toLowerCase()) && (
                      <small>não estava na lista de aguardando</small>
                    )}
                    {entry.unit && (
                      <small>
                        {splitAssetId(entry.unit).model} ·{" "}
                        {splitAssetId(entry.unit).code || entry.unit}
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
                    onClick={() =>
                      setEntries((prev) =>
                        prev.filter((other) => other.serial !== entry.serial),
                      )
                    }
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
              {entries.length} bipados · {approved} aprovados · {rejected}{" "}
              reprovados
            </span>
            <Button
              onClick={() => void save()}
              disabled={saving || !entries.length}
            >
              {saving ? "Registrando…" : "Registrar quarentena"}
            </Button>
          </div>

          <h3 className={styles.subtitle}>Por dia (últimos 30 dias)</h3>
          {days === "error" && (
            <div className={recordStyles.empty}>
              Não foi possível carregar os números por dia.
            </div>
          )}
          {days === null && (
            <div className={recordStyles.empty}>Carregando…</div>
          )}
          {Array.isArray(days) &&
            (days.length ? (
              <table className={styles.days}>
                <thead>
                  <tr>
                    <th>Dia</th>
                    <th>Liberados (aprovados)</th>
                    <th>Recusados (reprovados)</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((day) => (
                    <tr key={day.date}>
                      <td>{day.date.split("-").reverse().join("/")}</td>
                      <td>{day.approved}</td>
                      <td>{day.rejected}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td>{days.reduce((n, day) => n + day.approved, 0)}</td>
                    <td>{days.reduce((n, day) => n + day.rejected, 0)}</td>
                  </tr>
                </tfoot>
              </table>
            ) : (
              <div className={recordStyles.empty}>
                Nenhum registro nos últimos 30 dias.
              </div>
            ))}
        </>
      )}
    </section>
  );
}
