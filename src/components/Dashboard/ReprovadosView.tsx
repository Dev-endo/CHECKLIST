import { useEffect, useState } from "react";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchDashboardReprovados, type DashboardReprovado } from "../../services/supabase/dashboardService";
import styles from "./Dashboard.module.css";

const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Análise: aparelhos reprovados na quarentena, quando foram reprovados e quem fez cada etapa da última passagem. */
export function ReprovadosView({ client, from, to }: { client: AppSupabaseClient; from: string; to: string }) {
  const [rows, setRows] = useState<DashboardReprovado[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setRows(null);
    setFailed(false);
    let active = true;
    fetchDashboardReprovados(client, { from, to })
      .then((found) => active && setRows(found))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, from, to]);

  if (failed) return <p className={styles.warn}>Não foi possível carregar os reprovados. Rode a migration 103 no Supabase, se ainda não rodou.</p>;
  if (rows === null) return <p className={styles.muted}>Carregando…</p>;

  return (
    <>
      <div className={styles.cards}>
        <div className={[styles.card, styles.crit].join(" ")}>
          <span className={styles.cardValue}>{rows.length}</span>
          <span className={styles.cardLabel}>Aparelhos reprovados na quarentena</span>
          <span className={styles.muted}>cada serial conta uma vez</span>
        </div>
      </div>
      <p className={styles.muted}>
        Os responsáveis são os da última passagem do aparelho (OS mais recente). “—” quer dizer que a etapa não tem registro.
      </p>
      {rows.length === 0 && <p className={styles.muted}>Nenhum reprovado no período.</p>}
      {rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Reprovado em</th>
                <th>Serial</th>
                <th>OS</th>
                <th>Modelo</th>
                <th>Quem reprovou</th>
                <th>Técnico responsável</th>
                <th>Checklist</th>
                <th>Desmontagem</th>
                <th>Manutenção</th>
                <th>Montagem</th>
                <th>Manutenções feitas</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.serial}>
                  <td>
                    {when(row.reprovadoEm)}
                    {row.vezes > 1 ? ` (${row.vezes}x no período)` : ""}
                  </td>
                  <td className={styles.mono}>{row.serial}</td>
                  <td>{row.osNumber ?? "—"}</td>
                  <td>{row.model ?? "—"}</td>
                  <td>{row.reprovadoPor ?? "—"}</td>
                  <td>{row.responsavel ?? "—"}</td>
                  <td>{row.checklist ?? "—"}</td>
                  <td>{row.desmontagem ?? "—"}</td>
                  <td>{row.manutencao ?? "—"}</td>
                  <td>{row.montagem ?? "—"}</td>
                  <td>{row.feitas ? `${row.feitas}${row.feitasQtd ? ` (${row.feitasQtd})` : ""}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
