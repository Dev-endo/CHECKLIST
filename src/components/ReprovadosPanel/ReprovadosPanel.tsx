import { useEffect, useState, type ClipboardEvent, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { directRejected, listLabTechnicians, type DirectRejectedResult, type LabTechnician } from "../../services/supabase/labDayService";
import { splitAssetId } from "../../domain/device";
import { OUTCOME_LABELS } from "../../domain/repairChecklist";
import { describeRepairError } from "../../domain/repairStages";
import { assetsBySerial } from "../../services/supabase/stockBoardService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchReprovados, registerReprovados, type ReprovadoRow } from "../../services/supabase/repairService";
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
 * Reprovados (supervisor e admin): bipa vários seriais de uma vez (como na Quarentena) e, ao concluir, mostra por
 * aparelho o técnico responsável e quem fez a desmontagem, o checklist, a manutenção e a montagem. Depois, direciona os
 * reprovados para um técnico: cada um vira um balão no Checklist manutenção dele.
 */
export function ReprovadosPanel({ client }: { client: AppSupabaseClient }) {
  const toast = useToast();
  const [serial, setSerial] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReprovadoRow[] | null>(null);
  // Direcionar os reprovados para um técnico: cada serial vira um balão no Checklist manutenção dele.
  const { user } = useAuth();
  const myId = user?.id ?? "";
  const [technicians, setTechnicians] = useState<LabTechnician[]>([]);
  const [technicianId, setTechnicianId] = useState("");
  const [directed, setDirected] = useState<Map<string, DirectRejectedResult>>(new Map());
  // Marcados para direcionar (serial em minúsculas): cada um pode ir para um técnico diferente.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Bipar mais seriais depois do resultado: entram no fim da tabela.
  const [more, setMore] = useState("");
  useEffect(() => {
    let active = true;
    listLabTechnicians(client)
      .then(
        (found) =>
          active &&
          setTechnicians(
            [...found].sort((a, b) => Number(b.id === myId) - Number(a.id === myId) || a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" })),
          ),
      )
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, myId]);

  const direct = async () => {
    if (!result || !technicianId || busy) return;
    const pending = result.map((row) => row.serial).filter((value) => selected.has(value.toLowerCase()) && !directed.get(value.toLowerCase())?.ok);
    if (!pending.length) {
      toast("Marque os ativos que vão para este técnico.");
      return;
    }
    const name = technicians.find((item) => item.id === technicianId)?.name ?? "o técnico";
    if (!window.confirm(`Direcionar ${pending.length} ativo(s) para ${name}? Cada um vira um balão no Checklist manutenção dele.`)) return;
    setBusy(true);
    try {
      const found = await directRejected(client, pending, technicianId);
      setDirected((prev) => {
        const next = new Map(prev);
        for (const item of found) next.set(item.serial.toLowerCase(), item);
        return next;
      });
      // Os direcionados saem da seleção; os outros continuam marcados para tentar de novo ou escolher outro técnico.
      setSelected((prev) => {
        const next = new Set(prev);
        for (const item of found) if (item.ok) next.delete(item.serial.toLowerCase());
        return next;
      });
      const ok = found.filter((item) => item.ok).length;
      const skipped = found.length - ok;
      toast(`${ok} ativo(s) direcionado(s) para ${name}${skipped ? ` · ${skipped} não direcionado(s): veja a coluna Balão` : ""}`);
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível direcionar os ativos."));
    } finally {
      setBusy(false);
    }
  };

  const balloonLabel = (value: string) => {
    const item = directed.get(value.toLowerCase());
    if (!item) return "—";
    if (item.ok) return `Direcionado para ${item.holder ?? "o técnico"}`;
    if (item.reason === "com_tecnico") return `Já está com ${item.holder ?? "um técnico"}`;
    return "Serial fora da lista de ativos";
  };

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
      // Guarda o resultado para a Análise (a lista some depois de bipada).
      await registerReprovados(
        client,
        entries.map((entry) => entry.serial),
      ).catch(() => toast("A consulta apareceu, mas não foi guardada na Análise (falta rodar a migration 104)."));
      // Na ordem em que foram bipados; serial sem retorno aparece vazio.
      const byKey = new Map(found.map((row) => [row.serial.trim().toLowerCase(), row]));
      setResult(entries.map((entry) => byKey.get(entry.serial.trim().toLowerCase()) ?? emptyRow(entry.serial)));
      setSelected(new Set());
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível buscar os responsáveis. Tente de novo."));
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setResult(null);
    setEntries([]);
    setDirected(new Map());
    setSelected(new Set());
    setMore("");
  };

  // Na tela do resultado: bipa (ou cola) mais seriais; cada um entra no fim da tabela já marcado.
  const addMore = async (values: string[]) => {
    if (!result || busy) return;
    const known = new Set(result.map((row) => row.serial.trim().toLowerCase()));
    const fresh = [...new Map(values.map((value) => [value.toLowerCase(), value])).values()].filter((value) => !known.has(value.toLowerCase()));
    if (!fresh.length) {
      if (values.length) toast(values.length === 1 ? "Esse serial já está na tabela." : "Esses seriais já estão na tabela.");
      return;
    }
    const accepted = fresh.slice(0, Math.max(0, MAX_SERIALS - result.length));
    if (!accepted.length) {
      toast(`A lista aceita até ${MAX_SERIALS} seriais.`);
      return;
    }
    setBusy(true);
    try {
      const found = await fetchReprovados(client, accepted);
      await registerReprovados(client, accepted).catch(() => undefined);
      const units = new Map<string, string>();
      for (let i = 0; i < accepted.length; i += CHUNK) {
        const assets = await assetsBySerial(client, accepted.slice(i, i + CHUNK)).catch(() => null);
        assets?.forEach((asset, key) => units.set(key, asset.unit));
      }
      const byKey = new Map(found.map((row) => [row.serial.trim().toLowerCase(), row]));
      setEntries((prev) => [...prev, ...accepted.map((value) => ({ serial: value, unit: units.get(value.toLowerCase()) ?? null }))]);
      setResult((prev) => [...(prev ?? []), ...accepted.map((value) => byKey.get(value.toLowerCase()) ?? emptyRow(value))]);
      setSelected((prev) => new Set([...prev, ...accepted.map((value) => value.toLowerCase())]));
      if (accepted.length > 1) toast(`${accepted.length} seriais adicionados`);
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível buscar os responsáveis. Tente de novo."));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (value: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const key = value.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const unitOf = (serialValue: string) => entries.find((entry) => entry.serial === serialValue)?.unit ?? null;
  // Só dá para marcar quem ainda não foi direcionado.
  const selectable = (result ?? []).map((row) => row.serial.toLowerCase()).filter((key) => !directed.get(key)?.ok);
  const allSelected = selectable.length > 0 && selectable.every((key) => selected.has(key));
  const selectedCount = selectable.filter((key) => selected.has(key)).length;

  return (
    <section className={recordStyles.panel} aria-label="Reprovados">
      <div className={recordStyles.header}>
        <h2>Reprovados</h2>
      </div>

      {result ? (
        <>
          <form
            className={quarantineStyles.form}
            onSubmit={(e) => {
              e.preventDefault();
              const values = splitSerials(more);
              setMore("");
              void addMore(values);
            }}
          >
            <label className={quarantineStyles.serial}>
              Bipar mais
              <input
                value={more}
                onChange={(e) => setMore(e.target.value)}
                onPaste={(e) => {
                  const values = splitSerials(e.clipboardData.getData("text"));
                  if (values.length < 2) return;
                  e.preventDefault();
                  setMore("");
                  void addMore(values);
                }}
                placeholder="Bipe o serial e aperte Enter, ou cole vários de uma vez"
                autoComplete="off"
                autoFocus
                disabled={busy}
              />
            </label>
          </form>
          <p className={quarantineStyles.pendingNote}>
            Quem fez cada etapa de {result.length} aparelho(s), na OS mais recente de cada um. “—” quer dizer que a etapa não tem registro. Marque
            os ativos, escolha o técnico e clique em Direcionar; repita com outros ativos para outro técnico.
          </p>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Selecionar todos"
                      title="Selecionar todos"
                      checked={allSelected}
                      disabled={busy || !selectable.length}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(selectable))}
                    />
                  </th>
                  <th>Serial</th>
                  <th>OS</th>
                  <th>Técnico responsável</th>
                  <th>Desmontagem</th>
                  <th>Checklist</th>
                  <th>Manutenção</th>
                  <th>Manutenções feitas</th>
                  <th>Montagem</th>
                  <th>Quarentena</th>
                  <th>Balão</th>
                </tr>
              </thead>
              <tbody>
                {result.map((row) => {
                  const unit = unitOf(row.serial);
                  const key = row.serial.toLowerCase();
                  const done = !!directed.get(key)?.ok;
                  return (
                    <tr key={row.serial}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Selecionar ${row.serial}`}
                          checked={!done && selected.has(key)}
                          disabled={busy || done}
                          onChange={() => toggle(row.serial)}
                        />
                      </td>
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
                      <td>{balloonLabel(row.serial)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={quarantineStyles.footer}>
            <label style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <strong>Direcionar para técnico:</strong>
              <select value={technicianId} disabled={busy} onChange={(e) => setTechnicianId(e.target.value)} style={{ width: "auto" }}>
                <option value="">{technicians.length ? "Escolha o técnico…" : "Nenhum técnico encontrado"}</option>
                {technicians.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.id === myId ? " (você)" : ""}
                  </option>
                ))}
              </select>
              <Button disabled={busy || !technicianId || !selectedCount} onClick={() => void direct()}>
                {busy ? "Aguarde…" : `Direcionar${selectedCount ? ` (${selectedCount})` : ""}`}
              </Button>
            </label>
            <Button variant="ghost" onClick={restart}>
              Nova lista
            </Button>
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
