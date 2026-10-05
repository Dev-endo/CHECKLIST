import { useEffect, useState } from "react";
import { hasContent, toDeviceDoc, type DeviceDraft } from "../domain/device";
import { ReadOnlyError, type DeviceRepository } from "../services/deviceRepository";

const DEBOUNCE_MS = 500;

export type SaveState = "idle" | "saving" | "saved" | "error";

interface Options {
  repository: DeviceRepository | null;
  draft: DeviceDraft;
  revision: number;
  onCreated: (id: string, criado: string) => void;
}

/** Grava o rascunho com debounce a cada edição do usuário. */
export function useAutosave({ repository, draft, revision, onCreated }: Options) {
  const [status, setStatus] = useState<{ id: string; state: SaveState }>({ id: "", state: "idle" });
  const [readOnly, setReadOnly] = useState(false);

  // Disparado só por `revision`: abrir outro registro troca o rascunho sem
  // regravá-lo, e um salvamento pendente termina com o conteúdo que o originou.
  useEffect(() => {
    if (revision === 0 || !repository || readOnly || !hasContent(draft)) return;
    const snapshot = draft;
    setStatus({ id: snapshot.id, state: "saving" });
    const timer = setTimeout(async () => {
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
    return () => clearTimeout(timer);
  }, [revision]);

  return {
    saveState: status.id === draft.id ? status.state : "idle",
    readOnly,
  };
}
