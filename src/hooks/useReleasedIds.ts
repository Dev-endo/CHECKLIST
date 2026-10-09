import { useEffect, useMemo, useState } from "react";
import type { DeviceRecord } from "../domain/device";
import type { AppSupabaseClient } from "../services/supabase/client";
import { fetchReleasedIds } from "../services/supabase/releaseService";

/** Ids dos checklists que deixaram o aparelho "liberado para montagem" (último concluído do serial, liberado). */
export function useReleasedIds(client: AppSupabaseClient | null, records: readonly DeviceRecord[]): ReadonlySet<string> {
  const [released, setReleased] = useState<ReadonlySet<string>>(new Set());

  // Só concluídos e liberados podem ser o que libera o aparelho.
  const key = useMemo(
    () =>
      records
        .filter((r) => r.fase === "concluido" && r.status === "liberado")
        .map((r) => `${r.id}:${r.atualizado ?? ""}`)
        .sort()
        .join(","),
    [records],
  );

  useEffect(() => {
    if (!client || !key) {
      setReleased(new Set());
      return;
    }
    let active = true;
    const ids = key.split(",").map((entry) => entry.split(":")[0] ?? "");
    fetchReleasedIds(client, ids)
      .then((found) => active && setReleased(found))
      .catch(() => active && setReleased(new Set()));
    return () => {
      active = false;
    };
  }, [client, key]);

  return released;
}
