import { useEffect, useState } from "react";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  fetchQuarantineToday,
  type QuarantineResult,
  type QuarantineSerial,
} from "../../services/supabase/quarantineService";
import { Button } from "../Button/Button";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import { useToast } from "../Toast/ToastProvider";
import styles from "./QuarantinePanel.module.css";

const GROUPS: { id: QuarantineResult; label: string }[] = [
  { id: "aprovado", label: "aprovados" },
  { id: "reprovado", label: "reprovados" },
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Seriais bipados hoje, para copiar de uma vez os aprovados ou os reprovados (um por linha). */
export function QuarantineTodayView({
  client,
  reloadKey,
}: {
  client: AppSupabaseClient;
  reloadKey: number;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<QuarantineSerial[] | "error" | null>(null);

  useEffect(() => {
    let active = true;
    setRows(null);
    fetchQuarantineToday(client)
      .then((data) => active && setRows(data))
      .catch(() => active && setRows("error"));
    return () => {
      active = false;
    };
  }, [client, reloadKey]);

  if (rows === null)
    return <div className={recordStyles.empty}>Carregando…</div>;
  if (rows === "error")
    return (
      <div className={recordStyles.empty}>
        Não foi possível carregar os seriais de hoje.
      </div>
    );
  if (!rows.length)
    return <div className={recordStyles.empty}>Nenhum serial bipado hoje.</div>;

  const copy = async (id: QuarantineResult, label: string) => {
    const serials = rows
      .filter((row) => row.result === id)
      .map((row) => row.serial);
    toast(
      (await copyText(serials.join("\n")))
        ? `${serials.length} seriais ${label} copiados`
        : "Não foi possível copiar. Tente de novo.",
    );
  };

  return (
    <div className={styles.today}>
      {GROUPS.map(({ id, label }) => {
        const serials = rows
          .filter((row) => row.result === id)
          .map((row) => row.serial);
        return (
          <div key={id} className={styles.todayGroup}>
            <div className={styles.todayHead}>
              <strong>
                {serials.length} {label}
              </strong>
              <Button
                onClick={() => void copy(id, label)}
                disabled={!serials.length}
              >
                Copiar {label}
              </Button>
            </div>
            <ul className={styles.todayList}>
              {serials.map((serial) => (
                <li key={serial}>{serial}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
