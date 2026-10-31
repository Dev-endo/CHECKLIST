import { useCallback, useEffect, useRef, useState } from "react";
import { liveTotals, timerAction, type TimerTotals } from "../domain/repairStages";
import type { AppSupabaseClient } from "../services/supabase/client";
import { stageTimerApi, type TimerApi } from "../services/supabase/repairService";

const EMPTY: TimerTotals = { produtivo: 0, pausa: 0, espera_peca: 0, openKind: null };
const RESYNC_MS = 30_000;

/**
 * Cronômetro de uma etapa. A verdade está no banco: a tela só soma o tempo corrido desde a última leitura,
 * então recarregar a página ou fechar o navegador não perde nada.
 */
/** `api` troca de onde vêm os totais (padrão: o cronômetro de uma etapa). Precisa ser um objeto fixo, fora do componente. */
export function useRepairTimer(
  client: AppSupabaseClient,
  stageId: string | undefined,
  onError: (error: unknown) => void,
  api: TimerApi = stageTimerApi,
) {
  const [base, setBase] = useState<TimerTotals>(EMPTY);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const fetchedAt = useRef(Date.now());
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const refresh = useCallback(async () => {
    if (!stageId) return;
    try {
      const totals = await api.fetch(client, stageId);
      fetchedAt.current = Date.now();
      setBase(totals);
    } catch (error) {
      errorRef.current(error);
    }
  }, [client, stageId, api]);

  useEffect(() => {
    setBase(EMPTY);
    if (!stageId) return;
    void refresh();
    const resync = setInterval(() => void refresh(), RESYNC_MS);
    return () => clearInterval(resync);
  }, [stageId, refresh]);

  // Redesenha a cada segundo só enquanto há sessão aberta.
  useEffect(() => {
    if (!base.openKind) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [base.openKind]);

  const toggle = async () => {
    if (!stageId || busy) return;
    setBusy(true);
    try {
      await api.set(client, stageId, timerAction(base).next);
      await refresh();
    } catch (error) {
      errorRef.current(error);
    } finally {
      setBusy(false);
    }
  };

  /** Finalizar: para de contar agora (a etapa continua; dá para retomar depois). */
  const finish = async () => {
    if (!stageId || busy) return;
    setBusy(true);
    try {
      await api.set(client, stageId, "fim");
      await refresh();
    } catch (error) {
      errorRef.current(error);
    } finally {
      setBusy(false);
    }
  };

  void tick;
  const totals = liveTotals(base, (Date.now() - fetchedAt.current) / 1000);
  return { totals, action: timerAction(base), toggle, finish, busy, refresh };
}
