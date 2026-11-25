import { useCallback, useEffect, useState } from "react";
import { goalReached, type LabGoal as Goal } from "../../domain/labDay";
import { describeRepairError } from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { saveGoalNote } from "../../services/supabase/goalService";
import { fetchMyLabGoal } from "../../services/supabase/labDayService";
import { Button } from "../Button/Button";
import { useToast } from "../Toast/ToastProvider";
import styles from "./DailyGoal.module.css";

const POLL_MS = 30_000;
const NOTE_MIN = 5;

/**
 * Topo do Checklist manutenção: meta do dia pelos balões. Meta = balões do técnico (os de ontem continuam e entram de
 * novo); cada balão finalizado abate 1, qualquer que seja o destino (transferir também). Transferência recebida só
 * entra depois da confirmação. Abaixo da meta, a justificativa continua obrigatória.
 */
export function LabGoal({ client }: { client: AppSupabaseClient }) {
  const toast = useToast();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchMyLabGoal(client)
        .then((found) => active && setGoal(found))
        .catch(() => undefined);
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, reloads]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await saveGoalNote(client, draft);
      toast("Justificativa salva");
      setEditing(false);
      setReloads((n) => n + 1);
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível salvar a justificativa."));
    } finally {
      setBusy(false);
    }
  }, [client, draft, toast]);

  // Sem a migration 108 (ou sem conexão), a caixa não aparece.
  if (!goal) return null;
  const done = goalReached(goal);
  const percent = Math.min(100, Math.round((goal.finished / Math.max(1, goal.goal)) * 100));
  const missing = Math.max(0, goal.goal - goal.finished);
  const showForm = !done && goal.goal > 0 && (editing || !goal.justification);

  return (
    <section className={[styles.box, done ? styles.done : ""].join(" ")} aria-label="Meta do dia">
      <div className={styles.head}>
        <span className={styles.label}>Meta do dia · ativos finalizados</span>
        <strong className={styles.value}>
          {goal.finished}
          <span className={styles.of}> / {goal.goal}</span>
        </strong>
        <span className={styles.detail}>
          {goal.open} na bancada · Ativos transferidos: {goal.transferred}
          {goal.pending ? ` · ${goal.pending} aguardando sua confirmação (ainda fora da meta)` : ""}
        </span>
      </div>
      <div className={styles.track} role="progressbar" aria-valuemin={0} aria-valuemax={goal.goal} aria-valuenow={goal.finished}>
        <div className={styles.bar} style={{ width: `${percent}%` }} />
      </div>

      {/* Total de manutenções feitas hoje (o mesmo serial trabalhado de novo soma aqui, não na meta de ativos). */}
      <div className={styles.maint}>
        <span className={styles.label}>Manutenções feitas hoje</span>
        <strong className={styles.maintValue}>{goal.maintenances}</strong>
        <span className={styles.detail}>
          em {goal.checklists} {goal.checklists === 1 ? "checklist finalizado" : "checklists finalizados"}
        </span>
      </div>

      {done ? (
        <p className={styles.success} role="status">
          ✓ Meta concluída com sucesso!
        </p>
      ) : goal.goal === 0 ? null : showForm ? (
        <div className={styles.note}>
          <label htmlFor="lab-goal-note">
            Faltam {missing} para a meta. Se não finalizar todos os seus ativos hoje, justifique (obrigatório):
          </label>
          <textarea
            id="lab-goal-note"
            value={draft}
            rows={2}
            maxLength={1000}
            disabled={busy}
            placeholder="Ex.: aparelhos com muitas peças em falta, ajudei no vidro, fiquei na análise…"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className={styles.actions}>
            <Button variant="small" disabled={busy || draft.trim().length < NOTE_MIN} onClick={() => void save()}>
              Salvar justificativa
            </Button>
            {editing && (
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                Cancelar
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.note}>
          <p className={styles.saved}>
            <strong>Sua justificativa:</strong> {goal.justification}
          </p>
          <div className={styles.actions}>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(goal.justification ?? "");
                setEditing(true);
              }}
            >
              Editar
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
