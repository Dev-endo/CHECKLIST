import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { toDateInputValue } from "../../domain/device";
import {
  deskLabel,
  FLOW_LABELS,
  flowOverview,
  GROUP_LABELS,
  LAB_STATUS_LABELS,
  labOverview,
  matchesSerial,
  serialKey,
  technicianSummaries,
  toCsv,
  type BalloonRow,
  type BoardAsset,
  type FlowEvent,
  type FlowGroupId,
  type GroupId,
  type ListRow,
  type TechnicianSummary,
} from "../../domain/labDay";
import { canUseLabDay } from "../../domain/roles";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  fetchBalloonReport,
  fetchBoard,
  fetchLabFlow,
  fetchLabHistory,
  removeAssets,
  type LabHistoryEntry,
} from "../../services/supabase/labDayService";
import { describeRepairError } from "../../domain/repairStages";
import { fetchQuarantinePending } from "../../services/supabase/quarantineService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import styles from "./LabDay.module.css";

const POLL_MS = 30_000;
const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const EVENT_LABELS: Record<string, string> = {
  entrada: "Entrou no laboratório",
  entrega: "Entregue ao técnico",
  direcionamento_vidro: "Direcionado do Vidro",
  transferencia: "Transferido",
  confirmacao: "Recebimento confirmado",
  finalizacao: "Checklist finalizado",
  quarentena_aprovada: "Quarentena aprovada",
  quarentena_reprovada: "Reprovado na quarentena",
  redistribuicao: "Redistribuído",
  responsavel_trocado: "Responsável trocado (admin)",
  retorno: "Voltou para o técnico",
  pt_recusado: "PT recusado",
  retirado: "Retirado do técnico (supervisor)",
};

const startOfDay = (value: string) => new Date(`${value}T00:00:00`);
const nextDay = (value: string) => {
  const date = startOfDay(value);
  date.setDate(date.getDate() + 1);
  return date;
};

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** Dia Laboratório > Acompanhamento: o que entrou, o que saiu, onde está cada ativo e a mesa de cada técnico. */
export function TrackingTab() {
  const { user, client } = useAuth();
  if (!client || !user) return <p className={appStyles.banner}>Entre com a sua conta para usar o Dia Laboratório.</p>;
  if (!canUseLabDay(user.roles)) return <p className={appStyles.banner}>Só supervisor e admin usam o Dia Laboratório.</p>;
  return <Tracking client={client} />;
}

type Selection = { kind: "group"; id: GroupId } | { kind: "flow"; id: FlowGroupId } | { kind: "tech"; id: string } | null;

function Tracking({ client }: { client: AppSupabaseClient }) {
  const today = toDateInputValue(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [query, setQuery] = useState("");
  const [board, setBoard] = useState<BoardAsset[] | null>(null);
  const [balloons, setBalloons] = useState<BalloonRow[] | null>(null);
  // Operação no período: entradas, saídas e quarentena (D-1 → D).
  const [flow, setFlow] = useState<FlowEvent[] | null>(null);
  // Card Quarentena: a lista Aguardando da aba Quarentena.
  const [waitingQuarantine, setWaitingQuarantine] = useState<ListRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [history, setHistory] = useState<{
    serial: string;
    entries: LabHistoryEntry[] | null;
  } | null>(null);
  // Serial bipado na busca: o resultado aparece logo abaixo dos filtros.
  const [lookup, setLookup] = useState<{
    serial: string;
    entries: LabHistoryEntry[] | null;
  } | null>(null);
  // Sobe ao retirar um ativo do técnico: recarrega o acompanhamento na hora.
  const [reloads, setReloads] = useState(0);

  const range = useMemo(() => {
    const start = startOfDay(from <= to ? from : to);
    const end = nextDay(from <= to ? to : from);
    return { start, end };
  }, [from, to]);

  useEffect(() => {
    let active = true;
    const load = () =>
      Promise.all([
        fetchBoard(client, range.start, range.end),
        fetchBalloonReport(client, range.start, range.end),
        fetchLabFlow(client, range.start, range.end),
      ])
        .then(([foundBoard, foundBalloons, foundFlow]) => {
          if (!active) return;
          setBoard(foundBoard);
          setBalloons(foundBalloons);
          setFlow(foundFlow);
          setFailed(false);
        })
        .catch(() => active && setFailed(true));
    const loadWaiting = () =>
      fetchQuarantinePending(client)
        .then(
          (found) =>
            active &&
            setWaitingQuarantine(
              found.map((item) => ({
                serial: item.serial,
                unit: item.unit,
                os: item.osNumber === "—" ? null : item.osNumber,
                technician: item.technician,
                status: "Aguardando quarentena",
                at: item.sentAt,
              })),
            ),
        )
        .catch(() => undefined);
    void loadWaiting();
    void load();
    const poll = setInterval(() => {
      void load();
      void loadWaiting();
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, range, reloads]);

  const groups = useMemo(
    () => (board && balloons ? labOverview(board, balloons, range.start, range.end, waitingQuarantine) : null),
    [board, balloons, range, waitingQuarantine],
  );
  const flowGroups = useMemo(() => (flow ? flowOverview(flow, range.start, range.end, query) : null), [flow, range, query]);
  const people = useMemo(() => (balloons ? technicianSummaries(balloons, range.start, range.end) : null), [balloons, range]);

  const openHistory = (serial: string) => {
    setHistory({ serial, entries: null });
    fetchLabHistory(client, serial)
      .then((entries) => setHistory((current) => (current?.serial === serial ? { serial, entries } : current)))
      .catch(() => setHistory((current) => (current?.serial === serial ? { serial, entries: [] } : current)));
  };

  const lookUp = (value: string) => {
    const serial = value.trim();
    if (!serial) return setLookup(null);
    setLookup({ serial, entries: null });

    fetchLabHistory(client, serial)
      .then((entries) => setLookup((current) => (current?.serial === serial ? { serial, entries } : current)))
      .catch(() => setLookup((current) => (current?.serial === serial ? { serial, entries: [] } : current)));
  };

  // Onde o serial bipado está agora e em quais cards do período ele aparece.
  const lookupInfo = useMemo(() => {
    if (!lookup) return null;
    const key = serialKey(lookup.serial);
    const passages = (board ?? []).filter((asset) => serialKey(asset.serial) === key);
    const current = passages.find((asset) => !asset.exitedAt) ?? [...passages].sort((a, b) => b.enteredAt.localeCompare(a.enteredAt))[0];
    const cards: { label: string; select: Selection }[] = [];
    for (const id of Object.keys(flowGroups ?? {}) as FlowGroupId[]) {
      if (flowGroups?.[id].some((row) => serialKey(row.serial) === key)) cards.push({ label: FLOW_LABELS[id], select: { kind: "flow", id } });
    }
    for (const id of Object.keys(groups ?? {}) as GroupId[]) {
      if ((id.startsWith("lab_") && id !== "lab_total") || id.startsWith("destino_")) {
        if (groups?.[id].some((row) => serialKey(row.serial) === key))
          cards.push({
            label: GROUP_LABELS[id],
            select: { kind: "group", id },
          });
      }
    }
    return { current, cards };
  }, [lookup, board, flowGroups, groups]);

  const stat = (id: GroupId, tone = "", big = false) => {
    const active = selection?.kind === "group" && selection.id === id;
    return (
      <button
        type="button"
        className={[styles.stat, tone, big ? styles.statBig : "", active ? styles.statActive : ""].join(" ")}
        aria-pressed={active}
        onClick={() => setSelection(active ? null : { kind: "group", id })}
      >
        <span className={styles.statValue}>{groups ? groups[id].length : "…"}</span>
        <span>{GROUP_LABELS[id]}</span>
      </button>
    );
  };

  const flowStat = (id: FlowGroupId, tone = "", big = false) => {
    const active = selection?.kind === "flow" && selection.id === id;
    return (
      <button
        type="button"
        className={[styles.stat, tone, big ? styles.statBig : "", active ? styles.statActive : ""].join(" ")}
        aria-pressed={active}
        onClick={() => setSelection(active ? null : { kind: "flow", id })}
      >
        <span className={styles.statValue}>{flowGroups ? flowGroups[id].length : "…"}</span>
        <span>{FLOW_LABELS[id]}</span>
      </button>
    );
  };
  const totalActive = selection?.kind === "flow" && selection.id === "saidas_total";

  const selectedTech = selection?.kind === "tech" ? people?.find((item) => item.technicianId === selection.id) : undefined;
  const techList = selectedTech && (
    <TechnicianList
      client={client}
      summary={selectedTech}
      query={query}
      onClose={() => setSelection(null)}
      onSerial={openHistory}
      onChanged={() => setReloads((n) => n + 1)}
    />
  );

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Acompanhamento</h1>
        <p className={appStyles.subtitle}>
          Quantos ativos entraram, quantos saíram e onde está cada um. Clique em qualquer número para ver os ativos; clique no serial para ver o
          histórico.
        </p>
      </header>

      <div className={styles.filters}>
        <label>
          De
          <input type="date" value={from} max={today} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label>
          Até
          <input type="date" value={to} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
        <label>
          Buscar serial
          <input
            type="search"
            value={query}
            placeholder="Bipe ou digite + Enter"
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value.trim()) setLookup(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                lookUp(query);
              }
            }}
          />
        </label>
        {(from !== today || to !== today) && (
          <Button
            variant="ghost"
            onClick={() => {
              setFrom(today);
              setTo(today);
            }}
          >
            Hoje
          </Button>
        )}
      </div>

      {lookup && (
        <div className={styles.list} aria-label={`Serial ${lookup.serial}`}>
          <h3>
            <span className={styles.mono}>{lookup.serial}</span>
            {lookupInfo?.current
              ? ` · agora: ${LAB_STATUS_LABELS[lookupInfo.current.status]}${
                  lookupInfo.current.technician ? ` com ${lookupInfo.current.technician}` : ""
                }${lookupInfo.current.unit ? ` · ${lookupInfo.current.unit}` : ""}`
              : ""}
          </h3>
          <div className={styles.lookupBar}>
            {lookupInfo && lookupInfo.cards.length > 0 ? (
              <>
                <span className={styles.muted}>Aparece em:</span>
                {lookupInfo.cards.map((card) => (
                  <Button key={card.label + JSON.stringify(card.select)} variant="small" onClick={() => setSelection(card.select)}>
                    {card.label}
                  </Button>
                ))}
              </>
            ) : (
              lookupInfo && <span className={styles.muted}>Não aparece em nenhum card do período.</span>
            )}
            <Button
              variant="small"
              className={styles.lookupClose}
              onClick={() => {
                setLookup(null);
                setQuery("");
              }}
            >
              Fechar
            </Button>
          </div>
          <HistoryTable entries={lookup.entries} />
        </div>
      )}

      {failed && (
        <div className={appStyles.banner} role="alert">
          Não foi possível carregar o acompanhamento agora. Tentando de novo.
        </div>
      )}

      <h2 className={styles.section}>Entradas</h2>
      <div className={styles.stats}>
        {flowStat("entraram", "", true)}
        {flowStat("vidro_montagem", "", true)}
        {flowStat("retornaram", "", true)}
      </div>

      <h2 className={styles.section}>Saídas do laboratório</h2>
      <div className={styles.stats}>
        {flowStat("saida_pt", styles.statOk)}
        {flowStat("saida_bloqueado", styles.statCrit)}
        {flowStat("saida_revenda")}
      </div>
      <button
        type="button"
        className={[styles.totalLink, totalActive ? styles.statActive : ""].join(" ")}
        aria-pressed={totalActive}
        onClick={() => setSelection(totalActive ? null : { kind: "flow", id: "saidas_total" })}
      >
        {FLOW_LABELS.saidas_total}: {flowGroups ? flowGroups.saidas_total.length : "…"} (PT + Bloqueado + Revenda + Quarentena liberado)
      </button>

      <h2 className={styles.section}>Quarentena</h2>
      <div className={styles.stats}>
        {flowStat("quarentena_ontem")}
        {flowStat("quarentena_liberado", styles.statOk)}
        {flowStat("quarentena_recusado", styles.statCrit)}
        {flowStat("quarentena_ainda")}
      </div>

      {selection?.kind === "flow" && flowGroups && (
        <AssetList
          title={FLOW_LABELS[selection.id]}
          rows={flowGroups[selection.id]}
          query={query}
          onClose={() => setSelection(null)}
          onSerial={openHistory}
        />
      )}

      <h2 className={styles.section}>Por destino (checklists finalizados no período)</h2>
      <div className={styles.stats}>
        {stat("destino_pt")}
        {stat("destino_quarentena")}
        {stat("destino_vidro")}
        {stat("destino_analise")}
        {stat("destino_revenda")}
        {stat("destino_bloqueado", styles.statCrit)}
      </div>

      <h2 className={styles.section}>Ainda no laboratório (agora)</h2>
      <div className={styles.stats}>
        {stat("lab_aguardando")}
        {stat("lab_vidro")}
        {stat("lab_analise")}
        {stat("lab_quarentena")}
        {stat("lab_reprovados", styles.statCrit)}
        {stat("lab_pendentes")}
      </div>

      {selection?.kind === "group" && groups && (
        <AssetList
          title={GROUP_LABELS[selection.id]}
          rows={groups[selection.id]}
          query={query}
          onClose={() => setSelection(null)}
          onSerial={openHistory}
        />
      )}

      <h2 className={styles.section}>Por técnico</h2>
      {people === null && <p className={styles.muted}>Carregando…</p>}
      {people?.length === 0 && <p className={styles.muted}>Nenhum balão no período.</p>}
      <ul className={styles.people}>
        {people?.map((item) => {
          const open = selection?.kind === "tech" && selection.id === item.technicianId;
          return (
            <li key={item.technicianId}>
              <button
                type="button"
                className={[styles.person, open ? styles.statActive : ""].join(" ")}
                aria-expanded={open}
                onClick={() => setSelection(open ? null : { kind: "tech", id: item.technicianId })}
              >
                <span className={styles.personName}>
                  {item.name} · {item.desk}
                  <svg className={[styles.chevron, open ? styles.chevronOpen : ""].join(" ")} viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span>{deskLabel(item)}</span>
                <span className={styles.muted}>
                  {item.finished} finalizado(s) · Ativos transferidos: {item.transferred}
                </span>
              </button>
              {open && techList}
            </li>
          );
        })}
      </ul>

      {history && <HistoryPanel title="Histórico de" serial={history.serial} entries={history.entries} onClose={() => setHistory(null)} />}
    </>
  );
}

function HistoryTable({ entries }: { entries: LabHistoryEntry[] | null }) {
  if (entries === null) return <p className={styles.muted}>Carregando…</p>;
  if (!entries.length) return <p className={styles.muted}>Sem movimentos no Dia Laboratório.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Quando</th>
            <th>Movimento</th>
            <th>Por</th>
            <th>De</th>
            <th>Para</th>
            <th>Detalhe</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={`${entry.createdAt}-${index}`}>
              <td>{when(entry.createdAt)}</td>
              <td>{EVENT_LABELS[entry.kind] ?? entry.kind}</td>
              <td>{entry.actor ?? "—"}</td>
              <td>{entry.fromName ?? "—"}</td>
              <td>{entry.toName ?? "—"}</td>
              <td>{historyDetail(entry)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryPanel({
  title,
  serial,
  entries,
  onClose,
}: {
  title: string;
  serial: string;
  entries: LabHistoryEntry[] | null;
  onClose: () => void;
}) {
  return (
    <div className={styles.list} aria-label={`${title} ${serial}`}>
      <div className={styles.listHead}>
        <h3>
          {title} <span className={styles.mono}>{serial}</span>
        </h3>
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
      </div>
      <HistoryTable entries={entries} />
    </div>
  );
}

function historyDetail(entry: LabHistoryEntry): string {
  const detail = entry.detail;
  if (typeof detail.destino === "string") return `Destino: ${detail.destino}`;
  if (typeof detail.motivo === "string") return `Motivo: ${detail.motivo}`;
  if (detail.por === "tecnico_vidro") return "Pelo técnico de vidro";
  if (detail.por === "supervisor") return "Pelo supervisor";
  return "";
}

function AssetList({
  title,
  rows,
  query,
  onClose,
  onSerial,
}: {
  title: string;
  rows: ListRow[];
  query: string;
  onClose: () => void;
  onSerial: (serial: string) => void;
}) {
  const visible = rows.filter((row) => matchesSerial(row.serial, query));
  const exportCsv = () =>
    download(
      `${title.toLowerCase().replace(/[^a-z0-9]+/gi, "-")}.csv`,
      toCsv(
        ["Serial", "Unit ID", "OS", "Técnico", "Status/Destino", "Última movimentação"],
        visible.map((row) => [row.serial, row.unit, row.os, row.technician, row.status, when(row.at)]),
      ),
    );
  return (
    <div className={styles.list}>
      <div className={styles.listHead}>
        <h3>
          {title} · {visible.length}
        </h3>
        <div className={styles.actions}>
          <Button variant="small" disabled={!visible.length} onClick={exportCsv}>
            Exportar CSV
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Fechar
          </Button>
        </div>
      </div>
      {!visible.length ? (
        <p className={styles.muted}>Nenhum ativo{query ? " com esse serial" : ""}.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Serial</th>
                <th>Unit ID</th>
                <th>OS</th>
                <th>Técnico</th>
                <th>Status/Destino</th>
                <th>Última movimentação</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row, index) => (
                <tr key={`${row.serial}-${index}`}>
                  <td>
                    <button type="button" className={styles.serialLink} onClick={() => onSerial(row.serial)} title="Ver histórico">
                      {row.serial}
                    </button>
                  </td>
                  <td>{row.unit ?? "—"}</td>
                  <td>{row.os ?? "—"}</td>
                  <td>{row.technician ?? "—"}</td>
                  <td>{row.status}</td>
                  <td>{when(row.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TechnicianList({
  client,
  summary,
  query,
  onClose,
  onSerial,
  onChanged,
}: {
  client: AppSupabaseClient;
  summary: TechnicianSummary;
  query: string;
  onClose: () => void;
  onSerial: (serial: string) => void;
  onChanged: () => void;
}) {
  const visible = summary.rows.filter((row) => matchesSerial(row.serial, query));
  // Na bancada (aberto ou transferência pendente) é o que conta no número; o resto é o que ele já finalizou ou
  // transferiu no período (ex.: mandou para a quarentena) e aparece separado.
  const onBench = visible.filter((row) => row.removable);
  const done = visible.filter((row) => !row.removable);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const remove = async (serial: string) => {
    if (busy) return;
    if (
      !window.confirm(
        `Retirar ${serial} de ${summary.name} sem transferir para ninguém? Sai da bancada e da meta dele; se foi entregue por engano, sai também de "Entraram".`,
      )
    )
      return;
    setBusy(serial);
    setMessage(null);
    try {
      let [result] = await removeAssets(client, [serial]);
      if (result?.reason === "checklist_aberto") {
        if (
          !window.confirm(
            `Atenção: ${summary.name} já abriu o checklist de ${serial}. O checklist fica salvo e parado (${summary.name} não segue com ele); se o ativo for entregue de novo, quem receber assume o checklist com as marcações. Retirar assim mesmo?`,
          )
        )
          return;
        [result] = await removeAssets(client, [serial], true);
      }
      if (result?.ok) setMessage(`${serial} retirado de ${summary.name}.`);
      else setMessage(`${serial} já não está mais com ${summary.name}.`);
      onChanged();
    } catch (e) {
      setMessage(describeRepairError(e as { message?: string }, "Não foi possível retirar o ativo."));
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = () =>
    download(
      `ativos-${summary.name.toLowerCase().replace(/[^a-z0-9]+/gi, "-")}.csv`,
      toCsv(
        ["Técnico", "Serial", "Unit ID", "Status/Destino", "Transferido para", "Recebido de"],
        visible.map((row) => [row.technician, row.serial, row.unit, row.status, row.transferredTo, row.receivedFrom]),
      ),
    );
  return (
    <div className={styles.list}>
      <div className={styles.listHead}>
        <h3>
          {summary.name} · {deskLabel(summary)} · Ativos transferidos: {summary.transferred}
        </h3>
        <div className={styles.actions}>
          <Button variant="small" disabled={!visible.length} onClick={exportCsv}>
            Exportar CSV
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Fechar
          </Button>
        </div>
      </div>
      {message && (
        <p className={styles.muted} role="status">
          {message}
        </p>
      )}
      {!visible.length ? (
        <p className={styles.muted}>Nenhum ativo{query ? " com esse serial" : ""}.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Técnico</th>
                <th>Serial</th>
                <th>Unit ID</th>
                <th>Status/Destino</th>
                <th>Transferido para</th>
                <th>Recebido de</th>
                <th aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {[
                { title: `Na bancada (${onBench.length})`, rows: onBench },
                { title: `Já saiu da bancada no período (${done.length})`, rows: done },
              ]
                .filter((group) => group.rows.length)
                .flatMap((group) => [
                  <tr key={group.title} className={styles.groupRow}>
                    <th colSpan={7}>{group.title}</th>
                  </tr>,
                  ...group.rows.map((row, index) => (
                    <tr key={`${group.title}-${row.serial}-${index}`}>
                      <td>{row.technician}</td>
                      <td>
                        <button type="button" className={styles.serialLink} onClick={() => onSerial(row.serial)} title="Ver histórico">
                          {row.serial}
                        </button>
                      </td>
                      <td>{row.unit ?? "—"}</td>
                      <td>{row.status}</td>
                      <td>{row.transferredTo ?? "—"}</td>
                      <td>{row.receivedFrom ?? "—"}</td>
                      <td>
                        {row.removable && (
                          <Button
                            variant="small"
                            disabled={busy !== null}
                            onClick={() => void remove(row.serial)}
                            title="Retirar do técnico sem transferir"
                          >
                            {busy === row.serial ? "Retirando…" : "Retirar"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  )),
                ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
