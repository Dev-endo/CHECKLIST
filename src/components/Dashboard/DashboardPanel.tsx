import { useEffect, useState } from "react";
import { toDateInputValue } from "../../domain/device";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  fetchDevices,
  fetchMaintenanceDaily,
  fetchMaintenanceDevices,
  fetchMaintenancePeople,
  fetchPartDevices,
  fetchParts,
  fetchPeople,
  fetchPersonDaily,
  fetchSummary,
  type DashboardDay,
  type DashboardDevice,
  type DashboardKind,
  type DashboardPart,
  type DashboardPerson,
  type DashboardSummary,
  type MaintenanceDay,
  type MaintenanceDevice,
  type MaintenancePerson,
  type MaintenanceTotals,
} from "../../services/supabase/dashboardService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import { ProductivityView } from "./ProductivityView";
import styles from "./Dashboard.module.css";

type View = "geral" | "colaboradores" | "produtividade" | "manutencoes" | "pecas";

const VIEWS: { id: View; label: string }[] = [
  { id: "geral", label: "Visão geral" },
  { id: "colaboradores", label: "Colaborador" },
  { id: "produtividade", label: "Produtividade individual" },
  { id: "manutencoes", label: "Manutenções" },
  { id: "pecas", label: "Peças" },
];

const CARDS: { kind: DashboardKind; label: string; value: (s: DashboardSummary) => string; hint?: (s: DashboardSummary) => string; tone?: string }[] = [
  { kind: "quarentena", label: "Foram para a quarentena", value: (s) => String(s.quarentena) },
  { kind: "vidro", label: "Foram para o vidro", value: (s) => String(s.vidro) },
  { kind: "analise", label: "Foram para a análise técnica", value: (s) => String(s.analise) },
  { kind: "reparos", label: "Reparos feitos", value: (s) => String(s.reparos), hint: (s) => `em ${s.reparosAparelhos} aparelho(s)` },
  { kind: "bloqueados", label: "Bloqueados", value: (s) => String(s.bloqueados), tone: "crit" },
  { kind: "aprovados", label: "Aprovados na quarentena", value: (s) => String(s.aprovados), tone: "ok" },
  { kind: "reprovados", label: "Reprovados na quarentena", value: (s) => String(s.reprovados), tone: "crit" },
];

const daysAgo = (n: number) => {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return toDateInputValue(date);
};
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const dayLabel = (day: string) => day.split("-").reverse().join("/");

const DESTINO_LABELS: Record<string, string> = {
  quarentena: "Quarentena",
  vidro: "Vidro",
  analise: "Análise técnica",
  revenda: "Revenda",
  pt: "PT",
  bloqueado: "Bloqueado",
};

/** Colunas do caminho das peças até as manutenções. */
const FLOW_COLUMNS: { key: keyof MaintenanceTotals; label: string }[] = [
  { key: "aparelhos", label: "Aparelhos finalizados" },
  { key: "entregues", label: "Peças entregues" },
  { key: "devolvidas", label: "Testes devolvidos" },
  { key: "substituidas", label: "Substituídas por defeito" },
  { key: "testesUsados", label: "Testes usados de vez" },
  { key: "manutencoes", label: "Manutenções" },
];

/** Aparelho por aparelho (de um balão ou de uma peça). */
function DeviceTable({ rows, personLabel }: { rows: DashboardDevice[] | null; personLabel: string }) {
  if (rows === null) return <p className={styles.muted}>Carregando…</p>;
  if (!rows.length) return <p className={styles.muted}>Nenhum aparelho no período.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Serial</th>
            <th>OS</th>
            <th>Modelo</th>
            <th>{personLabel}</th>
            <th>Quando</th>
            <th>Detalhe</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${row.serial}-${row.at}-${i}`}>
              <td className={styles.mono}>{row.serial}</td>
              <td>{row.osNumber ?? "—"}</td>
              <td>{row.model ?? "—"}</td>
              <td>{row.person ?? "—"}</td>
              <td>{when(row.at)}</td>
              <td>{row.detail ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Meta diária do técnico: liberados para a quarentena e para o vidro. */
const GOAL = 6;

/** Aba Análise: balões do período, resultado por colaborador (com o dia a dia) e peças. */
export function DashboardPanel({ client }: { client: AppSupabaseClient }) {
  const [view, setView] = useState<View>("geral");
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(daysAgo(0));
  const [failed, setFailed] = useState(false);

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [kind, setKind] = useState<DashboardKind | null>(null);
  const [devices, setDevices] = useState<DashboardDevice[] | null>(null);

  const [people, setPeople] = useState<DashboardPerson[] | null>(null);
  const [person, setPerson] = useState<DashboardPerson | null>(null);
  const [daily, setDaily] = useState<DashboardDay[] | null>(null);

  const [crew, setCrew] = useState<MaintenancePerson[] | null>(null);
  const [tech, setTech] = useState<MaintenancePerson | null>(null);
  const [techDaily, setTechDaily] = useState<MaintenanceDay[] | null>(null);
  const [techDevices, setTechDevices] = useState<MaintenanceDevice[] | null>(null);

  const [parts, setParts] = useState<DashboardPart[] | null>(null);
  const [part, setPart] = useState<string | null>(null);
  const [partDevices, setPartDevices] = useState<DashboardDevice[] | null>(null);

  const period = { from, to };
  const periodKey = `${from}|${to}`;
  const valid = Boolean(from && to && from <= to);

  // Os dados de cada visão são lidos quando ela abre e quando o período muda.
  useEffect(() => {
    if (!valid) return;
    let active = true;
    setFailed(false);
    const done = <T,>(set: (value: T) => void) => (value: T) => active && set(value);
    const fail = () => active && setFailed(true);
    if (view === "geral") {
      setSummary(null);
      fetchSummary(client, period).then(done(setSummary)).catch(fail);
    } else if (view === "colaboradores") {
      setPeople(null);
      fetchPeople(client, period).then(done(setPeople)).catch(fail);
    } else if (view === "produtividade") {
      // A aba carrega os próprios dados (por dia).
    } else if (view === "manutencoes") {
      setCrew(null);
      fetchMaintenancePeople(client, period).then(done(setCrew)).catch(fail);
    } else {
      setParts(null);
      fetchParts(client, period).then(done(setParts)).catch(fail);
    }
    return () => {
      active = false;
    };
    // `period` é derivado de `periodKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, view, periodKey, valid]);

  useEffect(() => {
    setDevices(null);
    if (!kind || !valid) return;
    let active = true;
    fetchDevices(client, kind, period)
      .then((rows) => active && setDevices(rows))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, kind, periodKey, valid]);

  useEffect(() => {
    setDaily(null);
    if (!person || !valid) return;
    let active = true;
    fetchPersonDaily(client, person.userId, period)
      .then((rows) => active && setDaily(rows))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, person, periodKey, valid]);

  useEffect(() => {
    setTechDaily(null);
    setTechDevices(null);
    if (!tech || !valid) return;
    let active = true;
    fetchMaintenanceDaily(client, tech.userId, period)
      .then((rows) => active && setTechDaily(rows))
      .catch(() => active && setFailed(true));
    fetchMaintenanceDevices(client, tech.userId, period)
      .then((rows) => active && setTechDevices(rows))
      .catch(() => active && setTechDevices([]));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tech, periodKey, valid]);

  useEffect(() => {
    setPartDevices(null);
    if (!part || !valid) return;
    let active = true;
    fetchPartDevices(client, part, period)
      .then((rows) => active && setPartDevices(rows))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, part, periodKey, valid]);

  const preset = (days: number) => {
    setFrom(daysAgo(days));
    setTo(daysAgo(0));
  };

  const selectedCard = CARDS.find((card) => card.kind === kind);

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Análise</h1>
        <p className={appStyles.subtitle}>Resultados do laboratório no período. Clique num balão, num colaborador ou numa peça para ver o detalhe.</p>
      </header>

      {/* Produtividade individual escolhe um dia só (dentro da aba). */}
      {view !== "produtividade" && (
        <>
      <div className={styles.period}>
        <label>
          De
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Até
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <Button variant="small" onClick={() => preset(0)}>
          Hoje
        </Button>
        <Button variant="small" onClick={() => preset(6)}>
          7 dias
        </Button>
        <Button variant="small" onClick={() => preset(29)}>
          30 dias
        </Button>
      </div>
      {!valid && <p className={styles.warn}>Escolha um período válido (a data inicial não pode passar da final).</p>}
        </>
      )}
      {failed && (
        <div className={appStyles.banner} role="alert">
          Não foi possível carregar os números agora. Tente de novo.
        </div>
      )}

      <nav className={styles.tabs} aria-label="Visões da análise">
        {VIEWS.map((item) => (
          <button key={item.id} type="button" className={styles.tab} aria-current={view === item.id ? "page" : undefined} onClick={() => setView(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>

      {view === "geral" && (
        <>
          <div className={styles.cards}>
            {CARDS.map((card) => (
              <button
                key={card.kind}
                type="button"
                className={[styles.card, card.tone ? styles[card.tone] : "", kind === card.kind ? styles.cardOn : ""].join(" ")}
                aria-pressed={kind === card.kind}
                onClick={() => setKind(kind === card.kind ? null : card.kind)}
              >
                <span className={styles.cardValue}>{summary ? card.value(summary) : "…"}</span>
                <span className={styles.cardLabel}>{card.label}</span>
                {summary && card.hint && <span className={styles.muted}>{card.hint(summary)}</span>}
              </button>
            ))}
          </div>
          <p className={styles.muted}>Contagem por serial: o mesmo aparelho conta uma vez em cada balão.</p>
          {selectedCard && (
            <section className={styles.detail} aria-label={selectedCard.label}>
              <h2 className={styles.heading}>{selectedCard.label}: aparelho por aparelho</h2>
              <DeviceTable
                rows={devices}
                personLabel={
                  kind === "reparos" ? "Quem fez" : kind === "aprovados" || kind === "reprovados" ? "Quem registrou" : kind === "bloqueados" ? "Quem finalizou" : "Quem enviou"
                }
              />
            </section>
          )}
        </>
      )}

      {view === "produtividade" && <ProductivityView client={client} initialDay={to} />}

      {view === "manutencoes" && (
        <>
          <p className={styles.muted}>
            Cada peça usada de vez conta 1 manutenção para quem finaliza o aparelho. Substituir por defeito não soma: a peça trocada sai da conta e a
            substituta entra no lugar. Ex.: 10 entregues, 5 testes devolvidos, 5 usadas e 3 delas substituídas = 5 manutenções. Vidro e Aro não contam
            (são do técnico de vidro).
          </p>
          {crew === null && <p className={styles.muted}>Carregando…</p>}
          {crew?.length === 0 && <p className={styles.muted}>Nenhuma manutenção finalizada no período.</p>}
          {crew && crew.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Técnico</th>
                    {FLOW_COLUMNS.map((column) => (
                      <th key={column.key}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {crew.map((row) => (
                    <tr key={row.userId} className={tech?.userId === row.userId ? styles.rowOn : ""}>
                      <td>
                        <button type="button" className={styles.link} onClick={() => setTech(tech?.userId === row.userId ? null : row)}>
                          {row.name}
                        </button>
                      </td>
                      {FLOW_COLUMNS.map((column) => (
                        <td key={column.key}>{column.key === "manutencoes" ? <strong>{row[column.key]}</strong> : row[column.key]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tech && (
            <section className={styles.detail} aria-label={`Manutenções por dia de ${tech.name}`}>
              <h2 className={styles.heading}>Manutenções por dia: {tech.name}</h2>
              {techDaily === null && <p className={styles.muted}>Carregando…</p>}
              {techDaily?.length === 0 && <p className={styles.muted}>Nada no período.</p>}
              {techDaily && techDaily.length > 0 && (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Dia</th>
                        {FLOW_COLUMNS.map((column) => (
                          <th key={column.key}>{column.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {techDaily.map((row) => (
                        <tr key={row.day}>
                          <td>{dayLabel(row.day)}</td>
                          {FLOW_COLUMNS.map((column) => (
                            <td key={column.key}>{column.key === "manutencoes" ? <strong>{row[column.key]}</strong> : row[column.key]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h2 className={styles.heading}>Manutenções feitas: aparelho por aparelho</h2>
              {techDevices === null && <p className={styles.muted}>Carregando…</p>}
              {techDevices?.length === 0 && <p className={styles.muted}>Nenhum aparelho finalizado no período.</p>}
              {techDevices && techDevices.length > 0 && (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Quando</th>
                        <th>Serial</th>
                        <th>Modelo</th>
                        <th>OS</th>
                        <th>Onde</th>
                        <th>Destino</th>
                        <th>Manutenções</th>
                        <th>O que contou</th>
                        <th>Peças (entregues / devolvidas / substituídas)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {techDevices.map((row, i) => (
                        <tr key={`${row.serial}-${row.at}-${i}`}>
                          <td>{when(row.at)}</td>
                          <td>{row.serial}</td>
                          <td>{row.model ?? "—"}</td>
                          <td>{row.osNumber ?? "—"}</td>
                          <td>{row.origem}</td>
                          <td>{row.destino ? DESTINO_LABELS[row.destino] ?? row.destino : "—"}</td>
                          <td>
                            <strong>{row.manutencoes}</strong>
                          </td>
                          <td>{row.itens ?? "Nenhuma peça pelo sistema"}</td>
                          <td>
                            {row.entregues} / {row.devolvidas} / {row.substituidas}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {view === "colaboradores" && (
        <>
          {people === null && <p className={styles.muted}>Carregando…</p>}
          {people?.length === 0 && <p className={styles.muted}>Ninguém registrou trabalho no período.</p>}
          {people && people.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Colaborador</th>
                    <th>Manutenções</th>
                    <th>Peças de teste usadas de vez</th>
                    <th>Liberou para a quarentena</th>
                    <th>Liberou para o vidro</th>
                    <th>Liberou para a análise técnica</th>
                    <th>Placas</th>
                    <th>Vidros feitos</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((row) => (
                    <tr key={row.userId} className={person?.userId === row.userId ? styles.rowOn : ""}>
                      <td>
                        <button type="button" className={styles.link} onClick={() => setPerson(person?.userId === row.userId ? null : row)}>
                          {row.name}
                        </button>
                      </td>
                      <td>{row.manutencoes}</td>
                      <td>{row.testesUsados}</td>
                      <td>{row.quarentena}</td>
                      <td>{row.vidroEnviados}</td>
                      <td>{row.analiseEnviados}</td>
                      <td>{row.placas}</td>
                      <td>{row.vidros}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {person && (
            <section className={styles.detail} aria-label={`Desempenho diário de ${person.name}`}>
              <h2 className={styles.heading}>Desempenho diário: {person.name}</h2>
              {daily === null && <p className={styles.muted}>Carregando…</p>}
              {daily?.length === 0 && <p className={styles.muted}>Nada no período.</p>}
              {daily && daily.length > 0 && (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Dia</th>
                        <th>Manutenções</th>
                        <th>Peças de teste usadas de vez</th>
                        <th>Liberou para a quarentena</th>
                        <th>Liberou para o vidro</th>
                        <th>Liberou para a análise técnica</th>
                        <th>Placas</th>
                        <th>Vidros feitos</th>
                        <th>Meta (6)</th>
                        <th>Justificativa da meta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {daily.map((row) => (
                        <tr key={row.day}>
                          <td>{dayLabel(row.day)}</td>
                          <td>{row.manutencoes}</td>
                          <td>{row.testesUsados}</td>
                          <td>{row.quarentena}</td>
                          <td>{row.vidroEnviados}</td>
                          <td>{row.analiseEnviados}</td>
                          <td>{row.placas}</td>
                          <td>{row.vidros}</td>
                          <td>{row.liberados >= GOAL ? "✓ Batida" : `${row.liberados}/${GOAL}`}</td>
                          <td>{row.justificativa ?? (row.liberados >= GOAL ? "" : "—")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {view === "pecas" && (
        <>
          {parts === null && <p className={styles.muted}>Carregando…</p>}
          {parts?.length === 0 && <p className={styles.muted}>Nenhuma peça movimentada no período.</p>}
          {parts && parts.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Peça</th>
                    <th>Definitivas entregues</th>
                    <th>Testes entregues</th>
                    <th>Testes usados de vez</th>
                    <th>Testes devolvidos</th>
                    <th>Com defeito (substituídas)</th>
                  </tr>
                </thead>
                <tbody>
                  {parts.map((row) => (
                    <tr key={row.part} className={part === row.part ? styles.rowOn : ""}>
                      <td>
                        <button type="button" className={styles.link} onClick={() => setPart(part === row.part ? null : row.part)}>
                          {row.part}
                        </button>
                      </td>
                      <td>{row.definitivas}</td>
                      <td>{row.testes}</td>
                      <td>{row.testesUsados}</td>
                      <td>{row.devolvidas}</td>
                      <td>{row.defeito}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {part && (
            <section className={styles.detail} aria-label={`Peça ${part}`}>
              <h2 className={styles.heading}>{part}: aparelho por aparelho</h2>
              <DeviceTable rows={partDevices} personLabel="Quem pediu" />
            </section>
          )}
        </>
      )}
    </>
  );
}
