import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { canManageUsers } from "../../domain/roles";
import { describeRepairError } from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { decideChecklistRequest, listChecklistRequestsAll, type ChecklistRequestRow } from "../../services/supabase/repairService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import styles from "../GlassPanel/GlassPanel.module.css";
import { useToast } from "../Toast/ToastProvider";

const POLL_MS = 10_000;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const isToday = (iso: string | null) => Boolean(iso) && new Date(iso as string).toDateString() === new Date().toDateString();

const STATE_LABELS = { pendente: "Aguardando", aprovado: "Liberado", recusado: "Recusado", cancelado: "Cancelado" } as const;

/** Aba Liberação (só admin): pedidos dos colaboradores para assumir um checklist que está com outro técnico. */
export function ReleasePanel() {
  const { user, client } = useAuth();
  if (!client || !user) return <p className={appStyles.banner}>Entre com a sua conta para usar a Liberação.</p>;
  if (!canManageUsers(user.roles)) return <p className={appStyles.banner}>Só administradores acessam a Liberação.</p>;
  return <Release client={client} />;
}

function Release({ client }: { client: AppSupabaseClient }) {
  const toast = useToast();
  const [items, setItems] = useState<ChecklistRequestRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    const load = () =>
      listChecklistRequestsAll(client)
        .then((found) => {
          if (!active) return;
          setItems(found);
          setFailed(false);
        })
        .catch(() => active && setFailed(true));
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, reloads]);

  const decide = async (item: ChecklistRequestRow, approve: boolean) => {
    setBusy(item.id);
    try {
      await decideChecklistRequest(client, item.id, approve);
      toast(approve ? `Checklist de ${item.serial} liberado para ${item.requester}` : "Pedido recusado");
      reload();
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível decidir o pedido."));
      reload();
    } finally {
      setBusy(null);
    }
  };

  const pending = (items ?? []).filter((item) => item.status === "pendente");
  const approvedToday = (items ?? []).filter((item) => item.status === "aprovado" && isToday(item.decidedAt));
  const refusedToday = (items ?? []).filter((item) => item.status === "recusado" && isToday(item.decidedAt));

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Liberação</h1>
        <p className={appStyles.subtitle}>
          Pedidos dos colaboradores para assumir um checklist que está com outro técnico. Liberar passa o checklist para quem pediu, com as marcações já feitas.
        </p>
      </header>

      {failed && (
        <div className={appStyles.banner} role="alert">
          Não foi possível carregar os pedidos agora. Se ainda não rodou, rode a migration 106 no Supabase.
        </div>
      )}
      <div className={styles.summary}>
        <div className={[styles.stat, styles.statWait].join(" ")}>
          <span className={styles.statValue}>{items ? pending.length : "…"}</span>
          <span className={styles.statLabel}>Aguardando liberação</span>
          <span className={styles.muted}>pedidos esperando a sua decisão</span>
        </div>
        <div className={[styles.stat, styles.statDone].join(" ")}>
          <span className={styles.statValue}>{items ? approvedToday.length : "…"}</span>
          <span className={styles.statLabel}>Liberados hoje</span>
          <span className={styles.muted}>checklists passados para quem pediu</span>
        </div>
        <div className={[styles.stat, styles.statReady].join(" ")}>
          <span className={styles.statValue}>{items ? refusedToday.length : "…"}</span>
          <span className={styles.statLabel}>Recusados hoje</span>
          <span className={styles.muted}>pedidos negados no dia</span>
        </div>
      </div>

      {items === null && !failed && <p className={styles.muted}>Carregando…</p>}
      {items?.length === 0 && <p className={styles.muted}>Nenhum pedido de liberação.</p>}

      <ul className={styles.list}>
        {items?.map((item) => (
          <li key={item.id}>
            <div className={[styles.card, item.status === "pendente" ? styles.s_em_andamento : ""].join(" ")}>
              <div className={styles.head}>
                <strong className={styles.serial}>{item.serial}</strong>
                <span>{item.model ?? "Modelo não encontrado"}</span>
                {item.osNumber && <span className={styles.os}>OS {item.osNumber}</span>}
                <span className={styles.state}>{STATE_LABELS[item.status]}</span>
              </div>
              <p className={styles.who}>
                <strong>{item.requester}</strong> pediu para assumir o checklist que está com <strong>{item.owner}</strong> · pedido em {when(item.createdAt)}
                {item.decidedAt && item.status !== "pendente" ? ` · ${STATE_LABELS[item.status].toLowerCase()} por ${item.decidedBy ?? "—"} em ${when(item.decidedAt)}` : ""}
              </p>
              {item.status === "pendente" && (
                <div className={styles.actions}>
                  <Button disabled={busy === item.id} onClick={() => void decide(item, true)}>
                    Liberar para {item.requester}
                  </Button>
                  <Button variant="ghost" disabled={busy === item.id} onClick={() => void decide(item, false)}>
                    Recusar
                  </Button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
