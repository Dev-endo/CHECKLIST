import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { splitAssetId, toDateInputValue } from "../../domain/device";
import { destinationLabel, type Destination } from "../../domain/maintenance";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchProfiles, type Profile } from "../../services/supabase/profilesService";
import {
  fetchMaintenanceReport,
  type MaintenanceReport,
  type MaintenanceReportFilters,
} from "../../services/supabase/reportService";
import {
  fetchAssemblyReport,
  type AssemblyReport,
} from "../../services/supabase/assemblyService";
import { fetchDisassemblyReport, type DisassemblyReport } from "../../services/supabase/disassemblyService";
import { AnalysisDevicesDialog } from "../AnalysisDevicesDialog/AnalysisDevicesDialog";
import { CollaboratorsView } from "../AnalysisSearch/CollaboratorsView";
import { OsSearchView } from "../AnalysisSearch/OsSearchView";
import { PartsSearchView } from "../AnalysisSearch/PartsSearchView";
import { Button } from "../Button/Button";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import reviewStyles from "../ReviewPanel/ReviewPanel.module.css";
import styles from "./AnalysisPanel.module.css";

interface AnalysisPanelProps {
  client: AppSupabaseClient;
}

type View = "liberacoes" | "desmontagem" | "manutencoes" | "montagem" | "pecas" | "colaboradores" | "os";

const VIEWS: { id: View; label: string }[] = [
  { id: "liberacoes", label: "Liberações" },
  { id: "desmontagem", label: "Desmontagem" },
  { id: "manutencoes", label: "Manutenções" },
  { id: "montagem", label: "Montagem" },
  { id: "pecas", label: "Pesquisar peças" },
  { id: "colaboradores", label: "Pesquisar colaborador" },
  { id: "os", label: "Ordens de serviço" },
];

/** Clicar em um número abre a lista de aparelhos que o compõem. */
const DetailContext = createContext<(metric: string, label: string) => void>(() => undefined);

/** Recarrega sozinho a cada minuto e ao voltar para a aba, para não mostrar números velhos. */
const REFRESH_MS = 60_000;

const fmt = (n: number) => n.toLocaleString("pt-BR");
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** Por padrão, o mês corrente até hoje. */
const monthFilters = (): MaintenanceReportFilters => {
  const now = new Date();
  return { from: toDateInputValue(new Date(now.getFullYear(), now.getMonth(), 1)), to: toDateInputValue(now), userId: "" };
};

const todayFilters = (): MaintenanceReportFilters => {
  const today = toDateInputValue();
  return { from: today, to: today, userId: "" };
};

/** Análise para o supervisor: liberações, reprovações, manutenções e montagem no período. */
export function AnalysisPanel({ client }: AnalysisPanelProps) {
  const [view, setView] = useState<View>("liberacoes");
  const [filters, setFilters] = useState<MaintenanceReportFilters>(monthFilters);
  const [people, setPeople] = useState<Profile[]>([]);
  const [report, setReport] = useState<MaintenanceReport | null>(null);
  // Análise da montagem; null enquanto carrega, "error" se a consulta falhar (ex.: SQL da montagem ainda não rodado).
  const [assembly, setAssembly] = useState<AssemblyReport | null | "error">(null);
  // Análise da desmontagem; mesma convenção do assembly.
  const [disassembly, setDisassembly] = useState<DisassemblyReport | null | "error">(null);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [detail, setDetail] = useState<{ metric: string; label: string } | null>(null);
  // Filtros do último carregamento: trocar o filtro limpa os números; recarregar não.
  const loadedFilters = useRef<MaintenanceReportFilters | null>(null);
  // Dia em que os filtros "até hoje" foram montados: se a virada do dia passar, eles acompanham.
  const today = useRef(toDateInputValue());

  const setFilter = (key: keyof MaintenanceReportFilters, value: string) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    let active = true;
    fetchProfiles(client)
      .then((profiles) => active && setPeople(profiles))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    const tick = () => {
      const now = toDateInputValue();
      if (now !== today.current) {
        const before = today.current;
        today.current = now;
        setFilters((prev) => (prev.to === before ? { ...prev, to: now } : prev));
      }
      setReloads((n) => n + 1);
    };
    const timer = setInterval(tick, REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (loadedFilters.current !== filters) {
      loadedFilters.current = filters;
      setReport(null);
      setAssembly(null);
      setDisassembly(null);
    }
    setFailed(false);
    fetchMaintenanceReport(client, filters)
      .then((data) => active && setReport(data))
      .catch(() => active && setFailed(true));
    fetchAssemblyReport(client, filters)
      .then((data) => active && setAssembly(data))
      .catch(() => active && setAssembly("error"));
    fetchDisassemblyReport(client, filters)
      .then((data) => active && setDisassembly(data))
      .catch(() => active && setDisassembly("error"));
    return () => {
      active = false;
    };
  }, [client, filters, reloads]);

  let body: ReactNode;
  if (view === "os") body = <OsSearchView client={client} filters={filters} reloads={reloads} />;
  else if (view === "pecas") body = <PartsSearchView client={client} filters={filters} reloads={reloads} />;
  else if (view === "colaboradores") body = <CollaboratorsView client={client} filters={filters} reloads={reloads} />;
  else if (view === "montagem") body = <AssemblyView assembly={assembly} />;
  else if (view === "desmontagem") body = <DisassemblyView disassembly={disassembly} />;
  else if (failed) body = <div className={recordStyles.empty}>Não foi possível carregar a análise. Tente atualizar.</div>;
  else if (!report) body = <div className={recordStyles.empty}>Carregando análise…</div>;
  else if (view === "liberacoes") body = <ReleasesView report={report} assembly={assembly} disassembly={disassembly} />;
  else body = <MaintenancesView report={report} />;

  return (
    <section className={recordStyles.panel} aria-label="Análise">
      <div className={recordStyles.header}>
        <h2>Análise</h2>
        <div className={reviewStyles.actions}>
          <Button variant="small" onClick={() => setFilters(todayFilters())}>
            Hoje
          </Button>
          <Button variant="small" onClick={() => setFilters(monthFilters())}>
            Este mês
          </Button>
          <Button variant="small" onClick={() => setReloads((n) => n + 1)}>
            Atualizar
          </Button>
        </div>
      </div>
      <nav className={styles.views} aria-label="Tipos de análise">
        {VIEWS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={styles.view}
            aria-current={view === id ? "page" : undefined}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className={reviewStyles.filters}>
        <label className={reviewStyles.field}>
          De
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter("from", e.target.value)} />
        </label>
        <label className={reviewStyles.field}>
          Até
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter("to", e.target.value)} />
        </label>
        <label className={reviewStyles.field}>
          Colaborador
          <select value={filters.userId} onChange={(e) => setFilter("userId", e.target.value)}>
            <option value="">Todos</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name || person.email}
              </option>
            ))}
          </select>
        </label>
      </div>
      <DetailContext.Provider value={(metric, label) => setDetail({ metric, label })}>{body}</DetailContext.Provider>
      <AnalysisDevicesDialog client={client} detail={detail} filters={filters} onClose={() => setDetail(null)} />
    </section>
  );
}

function ReleasesView({
  report,
  assembly,
  disassembly,
}: {
  report: MaintenanceReport;
  assembly: AssemblyReport | null | "error";
  disassembly: DisassemblyReport | null | "error";
}) {
  const rows = report.byTechnician;
  const found = assembly && assembly !== "error" ? assembly : null;
  const dis = disassembly && disassembly !== "error" ? disassembly : null;
  return (
    <>
      <div className={styles.stats}>
        <Stat label="Desmontagem" metric="disassembled" value={dis?.total ?? 0} hint="normal + técnica; cada checklist conta" />
        <Stat label="Manutenções executadas" metric="maintenance_items" value={report.maintenancesTotal} hint="soma de todos os itens, incluindo a desmontagem técnica" />
        <Stat
          label="Enviados para montagem" metric="sent_assembly"
          value={report.releasedAssembly + (dis?.toAssembly ?? 0)}
          hint="liberados pela manutenção + enviados pela desmontagem; cada envio conta"
        />
        <Stat label="Aprovados na montagem" metric="assembly_approved" value={found?.released ?? 0} hint="serial = 1 ativo" />
        <Stat label="Reprovados na montagem" metric="assembly_rejected" value={found?.rejected ?? 0} hint="cada reprovação conta, mesmo do mesmo aparelho" />
        <Stat label="Enviados para vidro" metric="released_glass" value={report.releasedGlass} hint="pela manutenção; cada envio conta" />
        <Stat label="Enviados para análise técnica" metric="sent_analysis" value={report.sentAnalysis} hint="manutenção, desmontagem ou montagem; serial = 1 ativo" />
        <Stat label="Enviados para PT" metric="sent_pt" value={report.sentPt} hint="manutenção ou desmontagem técnica; serial = 1 ativo" />
        <Stat label="Enviados para quarentena" metric="sent_quarantine" value={found?.releasedQuarantine ?? 0} hint="montagem ou manutenção; serial = 1 ativo" />
        <Stat label="Aprovados na quarentena" metric="quarantine_approved" value={found?.quarantineApproved ?? 0} hint="cada registro conta" />
        <Stat label="Reprovados na quarentena" metric="quarantine_rejected" value={found?.quarantineRejected ?? 0} hint="cada registro conta" />
        <Stat label="Aguardando peça" metric="awaiting_part" value={report.awaitingPart} hint="continuam em manutenção; serial = 1 ativo" />
        <Stat label="Bloqueados" metric="blocked" value={found?.releasedBlock ?? 0} hint="manutenção, desmontagem ou montagem; serial = 1 ativo" />
      </div>
      {(assembly === "error" || disassembly === "error") && (
        <div className={recordStyles.empty}>Não foi possível carregar todos os números.</div>
      )}
      <h3 className={styles.subtitle}>Liberações por técnico</h3>
      <TechnicianTable
        empty="Nenhum checklist concluído neste período."
        headers={["Técnico", "Liberados para montagem"]}
        rows={rows.map((row) => [row.name, row.assembly])}
        totals={[sum(rows.map((r) => r.assembly))]}
      />
    </>
  );
}

/** Desmontagem: quantos foram desmontados e para onde cada um seguiu. */
function DisassemblyView({ disassembly }: { disassembly: DisassemblyReport | null | "error" }) {
  if (disassembly === "error") return <div className={recordStyles.empty}>Não foi possível carregar a análise da desmontagem.</div>;
  if (!disassembly) return <div className={recordStyles.empty}>Carregando análise…</div>;
  return (
    <div className={styles.stats}>
      <Stat label="Desmontados" metric="disassembled" value={disassembly.total} hint="desmontagem normal + técnica; cada checklist conta" />
      <Stat label="Enviados para montagem" metric="dis_assembly" value={disassembly.toAssembly} hint="cada envio conta" />
      <Stat label="Enviados para manutenção" metric="dis_maintenance" value={disassembly.toMaintenance} hint="cada envio conta" />
      <Stat label="Enviados para análise" metric="dis_analysis" value={disassembly.toAnalysis} hint="cada envio conta" />
      <Stat label="Viraram PT" metric="dis_pt" value={disassembly.toPt} hint="desmontagem técnica; cada envio conta" />
    </div>
  );
}

function MaintenancesView({ report }: { report: MaintenanceReport }) {
  const max = Math.max(1, ...report.byItem.map((row) => row.count));
  const placaMax = Math.max(1, ...report.placaDetails.map((row) => row.count));
  return (
    <>
      <div className={styles.stats}>
        <Stat label="Liberados para montagem" metric="released_assembly" value={report.releasedAssembly} hint="pela manutenção; cada liberação conta" />
        <Stat label="Enviados para vidro" metric="released_glass" value={report.releasedGlass} hint="continuam em manutenção; cada envio conta" />
        <Stat label="Aguardando peça" metric="awaiting_part" value={report.awaitingPart} hint="continuam em manutenção; serial = 1 ativo" />
        <Stat label="Manutenções feitas" metric="maintenance_items" value={report.maintenancesTotal} hint="soma de todos os itens, incluindo a desmontagem técnica" />
        <Stat label="Enviados para análise técnica" metric="sent_analysis" value={report.sentAnalysis} hint="manutenção, desmontagem ou montagem; serial = 1 ativo" />
        <Stat label="Enviados para PT" metric="sent_pt" value={report.sentPt} hint="desmontagem técnica; serial = 1 ativo" />
        <Stat label="Bloqueados" metric="blocked_maintenance" value={report.blockedMaintenance} hint="marcados bloqueados na manutenção; serial = 1 ativo" />
      </div>

      <h3 className={styles.subtitle}>Manutenções por tipo</h3>
      {report.byItem.length ? (
        <ul className={styles.bars}>
          {report.byItem.map((row) => (
            <li key={row.item}>
              <span className={styles.barLabel}>{row.item}</span>
              <span className={styles.track}>
                <i style={{ width: `${(row.count / max) * 100}%` }} />
              </span>
              <span className={styles.barValue}>{fmt(row.count)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={recordStyles.empty}>Nenhuma manutenção registrada neste período.</div>
      )}

      {report.placaDetails.length > 0 && (
        <>
          <h3 className={styles.subtitle}>Manutenções na placa</h3>
          <ul className={styles.bars}>
            {report.placaDetails.map((row) => (
              <li key={row.detail}>
                <span className={styles.barLabel}>{row.detail}</span>
                <span className={styles.track}>
                  <i style={{ width: `${(row.count / placaMax) * 100}%` }} />
                </span>
                <span className={styles.barValue}>{fmt(row.count)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** Montagem: aprovados e reprovados por montador, e a lista dos reprovados com o motivo. */
function AssemblyView({ assembly }: { assembly: AssemblyReport | null | "error" }) {
  if (assembly === "error") return <div className={recordStyles.empty}>Não foi possível carregar a análise da montagem.</div>;
  if (!assembly) return <div className={recordStyles.empty}>Carregando análise…</div>;
  const max = Math.max(1, ...assembly.byPart.map((row) => row.count));
  return (
    <>
      <div className={styles.stats}>
        <Stat label="Aparelhos montados" metric="assembled" value={assembly.checklists} hint="aprovados + reprovados; cada passagem conta, mesmo do mesmo serial" />
        <Stat label="Aprovados na montagem" metric="assembly_approved" value={assembly.released} hint="serial = 1 ativo" />
        <Stat label="Reprovados na montagem" metric="assembly_rejected" value={assembly.rejected} hint="cada reprovação conta, mesmo do mesmo aparelho" />
        <Stat label="Montagem enviada para análise" metric="assembly_analysis" value={assembly.returnedAnalysis} hint="reprovados na montagem; serial = 1 ativo" />
        <Stat label="Enviados para quarentena" metric="sent_quarantine" value={assembly.releasedQuarantine} hint="montagem ou manutenção; serial = 1 ativo" />
      </div>

      <h3 className={styles.subtitle}>Por montador</h3>
      <TechnicianTable
        empty="Nenhum checklist de montagem concluído neste período."
        headers={["Montador", "Aprovados", "Reprovados"]}
        rows={assembly.byAssembler.map((row) => [row.name, row.released, row.rejected])}
        totals={[sum(assembly.byAssembler.map((r) => r.released)), sum(assembly.byAssembler.map((r) => r.rejected))]}
      />

      <h3 className={styles.subtitle}>Reprovados na montagem</h3>
      {assembly.rejections.length ? (
        <div className={styles.tableWrap}>
          <table className={`${styles.table} ${styles.listTable}`}>
            <thead>
              <tr>
                <th>Modelo</th>
                <th>Unit ID</th>
                <th>Manutenção</th>
                <th>Montagem</th>
                <th>Motivo</th>
                <th>Direcionamento</th>
              </tr>
            </thead>
            <tbody>
              {assembly.rejections.map((row, index) => (
                <tr key={`${row.serial}-${index}`}>
                  <td>{row.unit ? splitAssetId(row.unit).model : "—"}</td>
                  <td>{row.unit ? splitAssetId(row.unit).code || row.unit : row.serial}</td>
                  <td>{row.technician ?? "—"}</td>
                  <td>{row.assembler}</td>
                  <td>
                    {[...row.reasons, ...row.parts.map((part) => `peça: ${part}`), ...(row.note ? [`obs.: ${row.note}`] : [])].join(" · ") || "—"}
                  </td>
                  <td>{row.destination ? destinationLabel(row.destination as Destination) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={recordStyles.empty}>Nenhum aparelho reprovado na montagem neste período.</div>
      )}

      {assembly.byPart.length > 0 && (
        <>
          <h3 className={styles.subtitle}>Peças com erro (um reprovado pode ter mais de uma peça)</h3>
          <ul className={styles.bars}>
            {assembly.byPart.map((row) => (
              <li key={row.part}>
                <span className={styles.barLabel}>{row.part}</span>
                <span className={styles.track}>
                  <i style={{ width: `${(row.count / max) * 100}%` }} />
                </span>
                <span className={styles.barValue}>{fmt(row.count)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function TechnicianTable({
  headers,
  rows,
  totals,
  empty,
}: {
  headers: string[];
  rows: (string | number)[][];
  totals: number[];
  empty: string;
}) {
  if (!rows.length) return <div className={recordStyles.empty}>{empty}</div>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row[0])}>
              {row.map((cell, index) => (
                <td key={index}>{typeof cell === "number" ? fmt(cell) : cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            {totals.map((total, index) => (
              <td key={index}>{fmt(total)}</td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Stat({ label, value, hint, metric }: { label: string; value: number; hint?: string; metric?: string }) {
  const open = useContext(DetailContext);
  const content = (
    <>
      <span className={styles.statValue}>{fmt(value)}</span>
      <span className={styles.statLabel}>{label}</span>
      {hint && <span className={styles.statHint}>{hint}</span>}
    </>
  );
  if (!metric) return <div className={styles.stat}>{content}</div>;
  return (
    <button type="button" className={`${styles.stat} ${styles.statButton}`} onClick={() => open(metric, label)}>
      {content}
    </button>
  );
}
