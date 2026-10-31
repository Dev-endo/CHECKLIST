import { useEffect, useState } from "react";
import { toDateInputValue } from "../../domain/device";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { call } from "../../services/supabase/repairService";
import styles from "./MyProduction.module.css";

interface Summary {
  ativos: number;
  quarentena: number;
  analise: number;
  vidro: number;
  revenda: number;
}

const POLL_MS = 20_000;

const daysAgo = (n: number) => {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return toDateInputValue(date);
};

const fetchMine = (client: AppSupabaseClient, from: string, to: string) =>
  call<Summary | null>(client, "repair_my_summary", { p_from: from, p_to: to });

const breakdown = (s: Summary) =>
  [
    s.quarentena && `${s.quarentena} quarentena`,
    s.analise && `${s.analise} análise técnica`,
    s.vidro && `${s.vidro} vidro`,
    s.revenda && `${s.revenda} revenda`,
  ]
    .filter(Boolean)
    .join(" · ");

/** Rodapé do técnico: quantos aparelhos ele mesmo finalizou hoje e nos últimos 7 dias, por destino. */
export function MyProduction({ client }: { client: AppSupabaseClient }) {
  const [today, setToday] = useState<Summary | null>(null);
  const [week, setWeek] = useState<Summary | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      const now = daysAgo(0);
      Promise.all([fetchMine(client, now, now), fetchMine(client, daysAgo(6), now)])
        .then(([day, last7]) => {
          if (!active) return;
          setToday(day);
          setWeek(last7);
        })
        .catch(() => undefined);
    };
    load();
    // Atualiza sozinho: cada aparelho finalizado entra na conta.
    const poll = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client]);

  if (!today || !week) return null;
  return (
    <footer className={styles.box} aria-label="Seus aparelhos">
      <div>
        <span className={styles.label}>Você fez hoje</span>
        <strong className={styles.value}>{today.ativos}</strong>
        <span className={styles.unit}>{today.ativos === 1 ? "aparelho" : "aparelhos"}</span>
        {today.ativos > 0 && <span className={styles.detail}>{breakdown(today)}</span>}
      </div>
      <div>
        <span className={styles.label}>Últimos 7 dias</span>
        <strong className={styles.value}>{week.ativos}</strong>
        <span className={styles.unit}>{week.ativos === 1 ? "aparelho" : "aparelhos"}</span>
        {week.ativos > 0 && <span className={styles.detail}>{breakdown(week)}</span>}
      </div>
    </footer>
  );
}
