import { useCallback, useMemo, useReducer } from "react";
import {
  blankDraft,
  draftFromRecord,
  type DeviceDraft,
  type DeviceRecord,
  type DraftField,
  type Results,
  type TestResult,
} from "../domain/device";
import { preferences } from "../services/preferences";

interface DraftState {
  draft: DeviceDraft;
  /** Cresce só com edições do usuário; é o gatilho do autosave. */
  revision: number;
}

type DraftAction =
  | { type: "setField"; field: DraftField; value: string }
  | { type: "toggleResult"; itemId: string; result: TestResult }
  | { type: "replace"; draft: DeviceDraft }
  /** Abre o registro com as marcações zeradas e grava isso. */
  | { type: "restart"; draft: DeviceDraft }
  /** Serial reconhecido na planilha de ativos: preenche unit id e modelo. */
  | { type: "applyAsset"; ativo: string; modelo: string }
  | { type: "clearAsset" }
  | { type: "markCreated"; id: string; criado: string };

function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case "setField":
      return { draft: { ...state.draft, [action.field]: action.value }, revision: state.revision + 1 };
    case "toggleResult": {
      const current = state.draft.r[action.itemId];
      const next: TestResult | "" = current === action.result ? "" : action.result;
      const r: Results = { ...state.draft.r, [action.itemId]: next };
      return { draft: { ...state.draft, r }, revision: state.revision + 1 };
    }
    case "replace":
      return { ...state, draft: action.draft };
    case "restart":
      return { draft: { ...action.draft, r: {} }, revision: state.revision + 1 };
    case "applyAsset":
      return { draft: { ...state.draft, ativo: action.ativo, modelo: action.modelo }, revision: state.revision + 1 };
    case "clearAsset":
      return { draft: { ...state.draft, ativo: undefined, modelo: "" }, revision: state.revision + 1 };
    case "markCreated":
      if (state.draft.id !== action.id || state.draft.criado) return state;
      return { ...state, draft: { ...state.draft, criado: action.criado } };
  }
}

function initState(tec: string): DraftState {
  return { draft: blankDraft(tec), revision: 0 };
}

/** `defaultTec`: técnico dos checklists novos (o usuário logado, ou o último digitado no modo local). */
export function useDeviceDraft(defaultTec: string) {
  const [{ draft, revision }, dispatch] = useReducer(draftReducer, defaultTec, initState);

  const rememberEdit = useCallback((id: string, tec: string) => {
    preferences.setCurrentDeviceId(id);
    preferences.setLastTech(tec);
  }, []);

  const setField = useCallback(
    (field: DraftField, value: string) => {
      dispatch({ type: "setField", field, value });
      rememberEdit(draft.id, field === "tec" ? value : draft.tec);
    },
    [draft.id, draft.tec, rememberEdit],
  );

  const toggleResult = useCallback(
    (itemId: string, result: TestResult) => {
      dispatch({ type: "toggleResult", itemId, result });
      rememberEdit(draft.id, draft.tec);
    },
    [draft.id, draft.tec, rememberEdit],
  );

  const openRecord = useCallback((record: DeviceRecord) => {
    dispatch({ type: "replace", draft: draftFromRecord(record) });
    preferences.setCurrentDeviceId(record.id);
  }, []);

  const restartRecord = useCallback((record: DeviceRecord) => {
    dispatch({ type: "restart", draft: draftFromRecord(record) });
    preferences.setCurrentDeviceId(record.id);
  }, []);

  const startNew = useCallback(() => {
    const next = blankDraft(defaultTec);
    dispatch({ type: "replace", draft: next });
    preferences.setCurrentDeviceId(next.id);
  }, [defaultTec]);

  const applyAsset = useCallback((ativo: string, modelo: string) => {
    dispatch({ type: "applyAsset", ativo, modelo });
  }, []);

  const clearAsset = useCallback(() => {
    dispatch({ type: "clearAsset" });
  }, []);

  const markCreated = useCallback((id: string, criado: string) => {
    dispatch({ type: "markCreated", id, criado });
  }, []);

  return useMemo(
    () => ({
      draft,
      revision,
      setField,
      toggleResult,
      openRecord,
      restartRecord,
      startNew,
      applyAsset,
      clearAsset,
      markCreated,
    }),
    [draft, revision, setField, toggleResult, openRecord, restartRecord, startNew, applyAsset, clearAsset, markCreated],
  );
}
