import { useEffect, useMemo, useState } from "react";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchIncorrectDefects, type IncorrectDefectRow } from "../../services/supabase/incorrectDefectService";
import styles from "./Dashboard.module.css";

const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Análise: ativos com divergência (defeito não identificado), quem identificou e qual defeito faltou. */
export function IncorrectDefectView({ client, from, to }: { client: AppSupabaseClient; from: string; to: string }) {
  const [rows, setRows] = useState<IncorrectDefectRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setRows(null);
    setFailed(false);
    let active = true;
    fetchIncorrectDefects(client, { from, to })
      .then((found) => active && setRows(found))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, from, to]);

  const summary = useMemo(() => {
    const list = rows ?? [];
    const assets = new Set(list.map((row) => row.serial.trim().toLowerCase()));
    const byPerson = new Map<string, { assets: Set<string>; records: number }>();
    for (const row of list) {
      const name = row.technician ?? "—";
      const entry = byPerson.get(name) ?? { assets: new Set<string>(), records: 0 };
      entry.assets.add(row.serial.trim().toLowerCase());
      entry.records += 1;
      byPerson.set(name, entry);
    }
    const byPart = new Map<string, number>();
    for (const row of list) byPart.set(row.part, (byPart.get(row.part) ?? 0) + 1);
    return {
      assets: assets.size,
      records: list.length,
      people: [...byPerson.entries()].map(([name, entry]) => ({ name, assets: entry.assets.size, records: entry.records })).sort((a, b) => b.assets - a.assets),
      parts: [...byPart.entries()].map(([part, count]) => ({ part, count })).sort((a, b) => b.count - a.count),
    };
  }, [rows]);

  if (failed) return <p className={styles.warn}>Não foi possível carregar os registros. Rode a migration 102 no Supabase, se ainda não rodou.</p>;
  if (rows === null) return <p className={styles.muted}>Carregando…</p>;

  return (
    <>
      <div className={styles.cards}>
        <div className={[styles.card, styles.crit].join(" ")}>
          <span className={styles.cardValue}>{summary.assets}</span>
          <span className={styles.cardLabel}>Ativos com divergência</span>
          <span className={styles.muted}>defeito não identificado</span>
        </div>
        <div className={styles.card}>
          <span className={styles.cardValue}>{summary.records}</span>
          <span className={styles.cardLabel}>Defeitos não identificados</span>
          <span className={styles.muted}>cada peça marcada conta 1</span>
        </div>
      </div>
      <p className={styles.muted}>Contagem de ativos por serial: o mesmo aparelho conta uma vez.</p>

      {rows.length === 0 && <p className={styles.muted}>Nenhum registro no período.</p>}

      {rows.length > 0 && (
        <>
          <h2 className={styles.heading}>Por técnico que identificou</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Técnico</th>
                  <th>Ativos</th>
                  <th>Defeitos não identificados</th>
                </tr>
              </thead>
              <tbody>
                {summary.people.map((person) => (
                  <tr key={person.name}>
                    <td>{person.name}</td>
                    <td>{person.assets}</td>
                    <td>{person.records}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className={styles.heading}>Por defeito (peça)</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Peça</th>
                  <th>Vezes</th>
                </tr>
              </thead>
              <tbody>
                {summary.parts.map((item) => (
                  <tr key={item.part}>
                    <td>{item.part}</td>
                    <td>{item.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className={styles.heading}>Ativo por ativo</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>OS</th>
                  <th>Modelo</th>
                  <th>Defeito não identificado</th>
                  <th>Observação</th>
                  <th>Técnico que identificou</th>
                  <th>Quando</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={`${row.serial}-${row.part}-${row.at}-${i}`}>
                    <td className={styles.mono}>{row.serial}</td>
                    <td>{row.osNumber ?? "—"}</td>
                    <td>{row.model ?? "—"}</td>
                    <td>{row.part}</td>
                    <td>{row.note ?? "—"}</td>
                    <td>{row.technician ?? "—"}</td>
                    <td>{when(row.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
