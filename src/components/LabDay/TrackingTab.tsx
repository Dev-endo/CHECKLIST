import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { toDateInputValue } from "../../domain/device";
import {
  deskLabel,
  GROUP_LABELS,
  labOverview,
  matchesSerial,
  technicianSummaries,
  toCsv,
  type BalloonRow,
  type BoardAsset,
  type GroupId,
  type ListRow,
  type TechnicianSummary,
} from "../../domain/labDay";
import { canUseLabDay } from "../../domain/roles";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchBalloonReport, fetchBoard, fetchLabHistory, type LabHistoryEntry } from "../../services/supabase/labDayService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import styles from "./LabDay.module.css";

const POLL_MS = 30_000;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

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

type Selection = { kind: "group"; id: GroupId } | { kind: "tech"; id: string } | null;

function Tracking({ client }: { client: AppSupabaseClient }) {
  const today = toDateInputValue(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [query, setQuery] = useState("");
  const [board, setBoard] = useState<BoardAsset[] | null>(null);
  const [balloons, setBalloons] = useState<BalloonRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [history, setHistory] = useState<{ serial: string; entries: LabHistoryEntry[] | null } | null>(null);

  const range = useMemo(() => {
    const start = startOfDay(from <= to ? from : to);
    const end = nextDay(from <= to ? to : from);
    return { start, end };
  }, [from, to]);

  useEffect(() => {
    let active = true;
    const load = () =>
      Promise.all([fetchBoard(client, range.start, range.end), fetchBalloonReport(client, range.start, range.end)])
        .then(([foundBoard, foundBalloons]) => {
          if (!active) return;
          setBoard(foundBoard);
          setBalloons(foundBalloons);
          setFailed(false);
        })
        .catch(() => active && setFailed(true));
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, range]);

  const groups = useMemo(() => (board && balloons ? labOverview(board, balloons, range.start, range.end) : null), [board, balloons, range]);
  const people = useMemo(() => (balloons ? technicianSummaries(balloons, range.start, range.end) : null), [balloons, range]);

  const openHistory = (serial: string) => {
    setHistory({ serial, entries: null });
    fetchLabHistory(client, serial)
      .then((entries) => setHistory((current) => (current?.serial === serial ? { serial, entries } : current)))
      .catch(() => setHistory((current) => (current?.serial === serial ? { serial, entries: [] } : current)));
  };

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

  const selectedTech = selection?.kind === "tech" ? people?.find((item) => item.technicianId === selection.id) : undefined;

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Acompanhamento</h1>
        <p className={appStyles.subtitle}>
          Quantos ativos entraram, quantos saíram (PT e quarentena aprovada) e onde está cada um. Clique em qualquer número para ver os ativos.
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
          <input type="search" value={query} placeholder="Serial" onChange={(e) => setQuery(e.target.value)} />
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

      {failed && (
        <div className={appStyles.banner} role="alert">
          Não foi possível carregar o acompanhamento agora. Tentando de novo.
        </div>
      )}

      <h2 className={styles.section}>Operação no período</h2>
      <div className={styles.stats}>
        {stat("entraram", "", true)}
        {stat("sairam", styles.statOk, true)}
      </div>

      <h2 className={styles.section}>Por destino (checklists finalizados no período)</h2>
      <div className={styles.stats}>
        {stat("destino_pt")}
        {stat("destino_quarentena")}
        {stat("destino_vidro")}
        {stat("destino_analise")}
        {stat("destino_revenda")}
        {stat("destino_bloqueado", styles.statCrit)}
      </div>

      <h2 className={styles.section}>Quarentena</h2>
      <div className={styles.stats}>
        {stat("quarentena_aguardando")}
        {stat("quarentena_aprovada", styles.statOk)}
        {stat("quarentena_reprovada", styles.statCrit)}
      </div>

      <h2 className={styles.section}>Ainda no laboratório (agora)</h2>
      <div className={styles.stats}>
        {stat("lab_total", "", true)}
        {stat("lab_aguardando")}
        {stat("lab_vidro")}
        {stat("lab_analise")}
        {stat("lab_quarentena")}
        {stat("lab_reprovados", styles.statCrit)}
        {stat("lab_pendentes")}
      </div>

      {selection?.kind === "group" && groups && (
        <AssetList title={GROUP_LABELS[selection.id]} rows={groups[selection.id]} query={query} onClose={() => setSelection(null)} onSerial={openHistory} />
      )}

      <h2 className={styles.section}>Por técnico</h2>
      {people === null && <p className={styles.muted}>Carregando…</p>}
      {people?.length === 0 && <p className={styles.muted}>Nenhum balão no período.</p>}
      <ul className={styles.people}>
        {people?.map((item) => (
          <li key={item.technicianId}>
            <button
              type="button"
              className={[styles.person, selection?.kind === "tech" && selection.id === item.technicianId ? styles.statActive : ""].join(" ")}
              onClick={() => setSelection(selection?.kind === "tech" && selection.id === item.technicianId ? null : { kind: "tech", id: item.technicianId })}
            >
              <span className={styles.personName}>
                {item.name} · {item.desk}
              </span>
              <span>{deskLabel(item)}</span>
              <span className={styles.muted}>
                {item.finished} finalizado(s) · Ativos transferidos: {item.transferred}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selectedTech && <TechnicianList summary={selectedTech} query={query} onClose={() => setSelection(null)} onSerial={openHistory} />}

      {history && (
        <div className={styles.list} aria-label={`Histórico de ${history.serial}`}>
          <div className={styles.listHead}>
            <h3>
              Histórico de <span className={styles.mono}>{history.serial}</span>
            </h3>
            <Button variant="ghost" onClick={() => setHistory(null)}>
              Fechar
            </Button>
          </div>
          {history.entries === null && <p className={styles.muted}>Carregando…</p>}
          {history.entries?.length === 0 && <p className={styles.muted}>Sem movimentos no Dia Laboratório.</p>}
          {history.entries && history.entries.length > 0 && (
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
                  {history.entries.map((entry, index) => (
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
          )}
        </div>
      )}
    </>
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

function AssetList({ title, rows, query, onClose, onSerial }: { title: string; rows: ListRow[]; query: string; onClose: () => void; onSerial: (serial: string) => void }) {
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

function TechnicianList({ summary, query, onClose, onSerial }: { summary: TechnicianSummary; query: string; onClose: () => void; onSerial: (serial: string) => void }) {
  const visible = summary.rows.filter((row) => matchesSerial(row.serial, query));
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
              </tr>
            </thead>
            <tbody>
              {visible.map((row, index) => (
                <tr key={`${row.serial}-${index}`}>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
