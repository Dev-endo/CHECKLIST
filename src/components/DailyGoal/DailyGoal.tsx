import { useCallback, useEffect, useState } from "react";
import { describeRepairError } from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchMyGoal, saveGoalNote, type DailyGoal as Goal } from "../../services/supabase/goalService";
import { Button } from "../Button/Button";
import { useToast } from "../Toast/ToastProvider";
import styles from "./DailyGoal.module.css";

const POLL_MS = 30_000;
const NOTE_MIN = 5;

/**
 * Topo do Reparo e do Checklist manutenção: aparelhos que o técnico liberou hoje para a quarentena e para o vidro,
 * contra a meta (6). Abaixo da meta, ele escreve a justificativa ali mesmo; batida, aparece "Meta concluída".
 */
export function DailyGoal({ client }: { client: AppSupabaseClient }) {
  const toast = useToast();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchMyGoal(client)
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

  // Sem a migration 82 (ou sem conexão), a caixa não aparece.
  if (!goal) return null;
  const done = goal.liberados >= goal.meta;
  const percent = Math.min(100, Math.round((goal.liberados / Math.max(1, goal.meta)) * 100));
  const showForm = !done && (editing || !goal.justificativa);

  return (
    <section className={[styles.box, done ? styles.done : ""].join(" ")} aria-label="Meta do dia">
      <div className={styles.head}>
        <span className={styles.label}>Meta do dia · liberados</span>
        <strong className={styles.value}>
          {goal.liberados}
          <span className={styles.of}> / {goal.meta}</span>
        </strong>
        <span className={styles.detail}>
          {goal.quarentena} quarentena · {goal.vidro} vidro
        </span>
      </div>
      <div className={styles.track} role="progressbar" aria-valuemin={0} aria-valuemax={goal.meta} aria-valuenow={goal.liberados}>
        <div className={styles.bar} style={{ width: `${percent}%` }} />
      </div>

      {goal.manutencao && (
        <div className={styles.maint}>
          <span className={styles.label}>Manutenções hoje</span>
          <strong className={styles.maintValue}>{goal.manutencao.manutencoes}</strong>
          <span className={styles.detail}>
            {goal.manutencao.entregues} peça(s) entregue(s) · {goal.manutencao.devolvidas} teste(s) devolvido(s) · {goal.manutencao.substituidas}{" "}
            substituída(s) · em {goal.manutencao.aparelhos} aparelho(s) finalizado(s)
          </span>
        </div>
      )}
      {done ? (
        <p className={styles.success} role="status">
          ✓ Meta concluída com sucesso!
        </p>
      ) : showForm ? (
        <div className={styles.note}>
          <label htmlFor="goal-note">
            Faltam {goal.meta - goal.liberados} para a meta. Se não bater os {goal.meta}, justifique (obrigatório):
          </label>
          <textarea
            id="goal-note"
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
            <strong>Sua justificativa:</strong> {goal.justificativa}
          </p>
          <div className={styles.actions}>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(goal.justificativa ?? "");
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
