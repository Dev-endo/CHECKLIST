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
  | { type: "reset" }
  | { type: "draft" }
  | { type: "merge"; phases: Record<ChecklistPhase, PhaseState> };

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
    case "draft":
      return { loaded: true, phases: blank(), dirty: new Set<ChecklistPhase>() };
    case "merge": {
      // O que foi marcado antes de bipar vale por cima do que já estava gravado, e é gravado em seguida.
      const dirty = new Set<ChecklistPhase>();
      const phases = { ...action.phases };
      for (const phase of PHASES) {
        const draft = state.phases[phase];
        if (!Object.keys(draft.results).length && draft.battery === undefined) continue;
        phases[phase] = { results: { ...action.phases[phase].results, ...draft.results }, battery: draft.battery ?? action.phases[phase].battery };
        dirty.add(phase);
      }
      return { loaded: true, phases, dirty };
    }
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
  /**
   * Checklist manutenção: sem etapa ainda, dá para marcar (rascunho, só na tela). Quando a etapa abre, o rascunho
   * entra por cima do que estava gravado e é gravado.
   */
  draft = false,
) {
  const [state, dispatch] = useReducer(reducer, { loaded: false, phases: blank(), dirty: new Set<ChecklistPhase>() });
  const stateRef = useRef(state);
  stateRef.current = state;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const previousStage = useRef<string | undefined>(undefined);
  useEffect(() => {
    const fromDraft = draft && !previousStage.current;
    previousStage.current = stageId;
    if (!stageId) {
      dispatch({ type: draft ? "draft" : "reset" });
      return;
    }
    if (!fromDraft) dispatch({ type: "reset" });
    let active = true;
    fetchChecklists(client, stageId)
      .then((saved) => {
        if (!active) return;
        const phases = { aberto: fromSaved(saved.aberto), fechado: fromSaved(saved.fechado) };
        dispatch(fromDraft ? { type: "merge", phases } : { type: "loaded", phases });
      })
      .catch((error) => active && errorRef.current(error));
    return () => {
      active = false;
    };
  }, [client, stageId, draft]);

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
