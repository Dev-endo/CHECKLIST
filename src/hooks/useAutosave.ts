import { useCallback, useEffect, useRef, useState } from "react";
import { isIdentified, toDeviceDoc, type DeviceDraft } from "../domain/device";
import { ReadOnlyError, type DeviceRepository } from "../services/deviceRepository";

const DEBOUNCE_MS = 500;

export type SaveState = "idle" | "saving" | "saved" | "error";

interface Options {
  repository: DeviceRepository | null;
  draft: DeviceDraft;
  revision: number;
  /** Falso quando o rascunho não pode ser gravado (concluído, de outro usuário, serial já pendente). */
  enabled: boolean;
  onCreated: (id: string, criado: string) => void;
}

/**
 * Grava o rascunho com debounce a cada edição do usuário, a partir do momento
 * em que modelo, serial e técnico estão preenchidos. `conclude` grava na hora e
 * marca o checklist como concluído.
 */
export function useAutosave({ repository, draft, revision, enabled, onCreated }: Options) {
  const [status, setStatus] = useState<{ id: string; state: SaveState }>({ id: "", state: "idle" });
  const [readOnly, setReadOnly] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Disparado só por `revision`: abrir outro registro troca o rascunho sem
  // regravá-lo, e um salvamento pendente termina com o conteúdo que o originou.
  useEffect(() => {
    if (revision === 0 || !repository || readOnly || !enabled || !isIdentified(draft)) return;
    const snapshot = draft;
    setStatus({ id: snapshot.id, state: "saving" });
    timer.current = setTimeout(async () => {
      const doc = toDeviceDoc(snapshot, new Date().toISOString());
      try {
        await repository.save(snapshot.id, doc);
        setStatus({ id: snapshot.id, state: "saved" });
        onCreated(snapshot.id, doc.criado);
      } catch (error) {
        if (error instanceof ReadOnlyError) {
          setReadOnly(true);
          setStatus({ id: snapshot.id, state: "idle" });
        } else {
          setStatus({ id: snapshot.id, state: "error" });
        }
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer.current);
  }, [revision]);

  const conclude = useCallback(
    async (snapshot: DeviceDraft): Promise<boolean> => {
      if (!repository || readOnly) return false;
      // O autosave pendente gravaria a versão ainda "pendente" depois da conclusão.
      clearTimeout(timer.current);
      setStatus({ id: snapshot.id, state: "saving" });
      try {
        await repository.save(snapshot.id, toDeviceDoc({ ...snapshot, fase: "concluido" }, new Date().toISOString()));
        setStatus({ id: snapshot.id, state: "saved" });
        return true;
      } catch (error) {
        if (error instanceof ReadOnlyError) setReadOnly(true);
        setStatus({ id: snapshot.id, state: "error" });
        return false;
      }
    },
    [repository, readOnly],
  );

  return {
    saveState: status.id === draft.id ? status.state : "idle",
    readOnly,
    conclude,
  };
}
