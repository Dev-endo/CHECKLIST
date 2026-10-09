import { useEffect, useState, type ReactNode } from "react";
import { splitAssetId, toDateInputValue } from "../../domain/device";
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
import { Button } from "../Button/Button";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import reviewStyles from "../ReviewPanel/ReviewPanel.module.css";
import styles from "./AnalysisPanel.module.css";

interface AnalysisPanelProps {
  client: AppSupabaseClient;
}

type View = "liberacoes" | "manutencoes" | "montagem";

const VIEWS: { id: View; label: string }[] = [
  { id: "liberacoes", label: "Liberações" },
  { id: "manutencoes", label: "Manutenções" },
  { id: "montagem", label: "Montagem" },
];

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
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);

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
    let active = true;
    setReport(null);
    setAssembly(null);
    setFailed(false);
    fetchMaintenanceReport(client, filters)
      .then((data) => active && setReport(data))
      .catch(() => active && setFailed(true));
    fetchAssemblyReport(client, filters)
      .then((data) => active && setAssembly(data))
      .catch(() => active && setAssembly("error"));
    return () => {
      active = false;
    };
  }, [client, filters, reloads]);

  let body: ReactNode;
  if (view === "montagem") body = <AssemblyView assembly={assembly} />;
  else if (failed) body = <div className={recordStyles.empty}>Não foi possível carregar a análise. Tente atualizar.</div>;
  else if (!report) body = <div className={recordStyles.empty}>Carregando análise…</div>;
  else if (view === "liberacoes") body = <ReleasesView report={report} assembly={assembly} />;
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
      {body}
    </section>
  );
}

function ReleasesView({ report, assembly }: { report: MaintenanceReport; assembly: AssemblyReport | null | "error" }) {
  const rows = report.byTechnician;
  const found = assembly && assembly !== "error" ? assembly : null;
  return (
    <>
      <div className={styles.stats}>
        <Stat label="Aparelhos que foram para montagem" value={found?.checklists ?? 0} hint="aprovados + reprovados; cada passagem conta, mesmo do mesmo serial" />
        <Stat label="Ativos liberados" value={found?.released ?? 0} hint="aprovados na montagem, serial = 1 ativo" />
        <Stat label="Reprovados na montagem" value={found?.rejected ?? 0} hint="cada reprovação conta, mesmo do mesmo aparelho" />
        <Stat label="Manutenções executadas" value={report.maintenancesTotal} hint="soma de todos os itens" />
        <Stat label="Liberados para revenda" value={report.releasedResale} hint="Face ID com defeito: laudo e revenda" />
        <Stat label="Enviados para análise técnica" value={report.sentAnalysis} hint="ativos, serial = 1 ativo" />
        <Stat label="Checklists de manutenção concluídos" value={report.checklists} />
      </div>
      {assembly === "error" && (
        <div className={recordStyles.empty}>Não foi possível carregar os números da montagem.</div>
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

function MaintenancesView({ report }: { report: MaintenanceReport }) {
  const max = Math.max(1, ...report.byItem.map((row) => row.count));
  const placaMax = Math.max(1, ...report.placaDetails.map((row) => row.count));
  return (
    <>
      <div className={styles.stats}>
        <Stat label="Ativos com manutenção" value={report.assetsWithMaintenance} />
        <Stat label="Manutenções feitas" value={report.maintenancesTotal} hint="soma de todos os itens" />
        <Stat label="Enviados para vidro" value={report.releasedGlass} hint="continuam em manutenção" />
        <Stat label="Enviados para análise técnica" value={report.sentAnalysis} hint="ativos, serial = 1 ativo" />
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
        <Stat label="Aparelhos que foram para montagem" value={assembly.checklists} hint="aprovados + reprovados; cada passagem conta, mesmo do mesmo serial" />
        <Stat label="Liberados na montagem" value={assembly.released} hint="serial = 1 ativo" />
        <Stat label="Reprovados na montagem" value={assembly.rejected} hint="cada reprovação conta, mesmo do mesmo aparelho" />
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
              </tr>
            </thead>
            <tbody>
              {assembly.rejections.map((row, index) => (
                <tr key={`${row.serial}-${index}`}>
                  <td>{row.unit ? splitAssetId(row.unit).model : "—"}</td>
                  <td>{row.unit ? splitAssetId(row.unit).code || row.unit : row.serial}</td>
                  <td>{row.technician ?? "—"}</td>
                  <td>{row.assembler}</td>
                  <td>{[...row.reasons, ...row.parts.map((part) => `peça: ${part}`)].join(" · ") || "—"}</td>
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

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{fmt(value)}</span>
      <span className={styles.statLabel}>{label}</span>
      {hint && <span className={styles.statHint}>{hint}</span>}
    </div>
  );
}
