import { useCallback, useEffect, useReducer, useRef } from "react";
import { setConfirmation, toggleItemFailure, type Results, type TestResult } from "../domain/device";
import { fromSaved, PHASES, phaseCatalog, toggleBlockResult, toSaved, type ChecklistPhase } from "../domain/repairChecklist";
import type { AppSupabaseClient } from "../services/supabase/client";
import { fetchChecklists, saveChecklist } from "../services/supabase/repairService";

export interface PhaseState {
  results: Results;
  battery: number | undefined;
}

interface State {
  loaded: boolean;
  phases: Record<ChecklistPhase, PhaseState>;
  /** Fases com marcação ainda não gravada. */
  dirty: ReadonlySet<ChecklistPhase>;
}

type Action =
  | { type: "loaded"; phases: Record<ChecklistPhase, PhaseState> }
  | { type: "edit"; phase: ChecklistPhase; next: PhaseState }
  | { type: "saved"; phase: ChecklistPhase; sent: PhaseState }
  | { type: "reset" };

const blank = (): Record<ChecklistPhase, PhaseState> => ({
  aberto: { results: {}, battery: undefined },
  fechado: { results: {}, battery: undefined },
});

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "loaded":
      return { loaded: true, phases: action.phases, dirty: new Set<ChecklistPhase>() };
    case "edit":
      return { ...state, phases: { ...state.phases, [action.phase]: action.next }, dirty: new Set<ChecklistPhase>([...state.dirty, action.phase]) };
    case "saved": {
      // Só some da lista se nada mudou enquanto gravava.
      const current = state.phases[action.phase];
      if (current !== action.sent) return state;
      const dirty = new Set<ChecklistPhase>(state.dirty);
      dirty.delete(action.phase);
      return { ...state, dirty };
    }
    case "reset":
      return { loaded: false, phases: blank(), dirty: new Set<ChecklistPhase>() };
  }
}

const SAVE_DELAY_MS = 700;

/**
 * Checklists da manutenção (aparelho aberto e fechado): lê o que está gravado e grava sozinho cada marcação,
 * pouco depois de o técnico parar de marcar. `flush` grava na hora o que estiver pendente (antes de finalizar).
 */
export function useRepairChecklists(
  client: AppSupabaseClient,
  stageId: string | undefined,
  editable: boolean,
  onError: (error: unknown) => void,
) {
  const [state, dispatch] = useReducer(reducer, { loaded: false, phases: blank(), dirty: new Set<ChecklistPhase>() });
  const stateRef = useRef(state);
  stateRef.current = state;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!stageId) return;
    let active = true;
    fetchChecklists(client, stageId)
      .then((saved) => {
        if (!active) return;
        const open = fromSaved(saved.aberto);
        const closed = fromSaved(saved.fechado);
        dispatch({ type: "loaded", phases: { aberto: open, fechado: closed } });
      })
      .catch((error) => active && errorRef.current(error));
    return () => {
      active = false;
    };
  }, [client, stageId]);

  const persist = useCallback(
    async (phase: ChecklistPhase) => {
      if (!stageId) return;
      const sent = stateRef.current.phases[phase];
      try {
        await saveChecklist(client, stageId, phase, toSaved(sent.results, sent.battery));
        dispatch({ type: "saved", phase, sent });
      } catch (error) {
        errorRef.current(error);
      }
    },
    [client, stageId],
  );

  const dirtyKey = [...state.dirty].join(",");
  useEffect(() => {
    if (!dirtyKey || !editable) return;
    const timer = setTimeout(() => {
      for (const phase of dirtyKey.split(",") as ChecklistPhase[]) void persist(phase);
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dirtyKey, state.phases, editable, persist]);

  const flush = useCallback(async () => {
    await Promise.all([...stateRef.current.dirty].map((phase) => persist(phase)));
  }, [persist]);

  const edit = (phase: ChecklistPhase, change: (current: PhaseState) => PhaseState) => {
    if (!editable) return;
    dispatch({ type: "edit", phase, next: change(stateRef.current.phases[phase]) });
  };

  return {
    loaded: state.loaded,
    phases: state.phases,
    results: Object.fromEntries(PHASES.map((phase) => [phase, state.phases[phase].results])) as Record<ChecklistPhase, Results>,
    unsaved: state.dirty.size > 0,
    flush,
    toggleResult: (phase: ChecklistPhase, sectionId: string, result: TestResult) =>
      edit(phase, (c) => {
        // Tópicos fora dos catálogos da fase (ex.: as perguntas de peças faltando, do Estágio 1) não têm itens a limpar.
        const block = phaseCatalog(phase).find((b) => b.id === sectionId) ?? { id: sectionId, title: sectionId, items: [] };
        return { ...c, results: toggleBlockResult(c.results, block, result) };
      }),
    toggleItem: (phase: ChecklistPhase, sectionId: string, itemId: string) =>
      edit(phase, (c) => ({ ...c, results: toggleItemFailure(c.results, sectionId, itemId) })),
    setConfirm: (phase: ChecklistPhase, itemId: string, checked: boolean) =>
      edit(phase, (c) => ({ ...c, results: setConfirmation(c.results, itemId, checked) })),
    setBattery: (phase: ChecklistPhase, value: number | undefined) => edit(phase, (c) => ({ ...c, battery: value })),
  };
}
