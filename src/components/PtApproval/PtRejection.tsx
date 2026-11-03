import { useEffect, useState } from "react";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchPtRejection, type PtRequest } from "../../services/supabase/ptService";
import styles from "./PtApproval.module.css";

const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Aviso ao técnico: o PT que ele pediu foi reprovado, com o comentário de quem reprovou. */
export function PtRejection({ client, stageId }: { client: AppSupabaseClient; stageId: string }) {
  const [rejected, setRejected] = useState<PtRequest | null>(null);

  useEffect(() => {
    setRejected(null);
    let active = true;
    fetchPtRejection(client, stageId)
      .then((found) => active && setRejected(found))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, stageId]);

  if (!rejected) return null;
  return (
    <div className={styles.rejected} role="status">
      <strong>PT reprovado</strong> por {rejected.decidedBy ?? "—"}
      {rejected.decidedAt ? ` em ${when(rejected.decidedAt)}` : ""}.
      {rejected.decisionNote && (
        <p>
          <strong>Comentário:</strong> {rejected.decisionNote}
        </p>
      )}
      <p className={styles.muted}>Seu motivo: {rejected.reason}. Escolha outro destino e finalize de novo.</p>
    </div>
  );
}
