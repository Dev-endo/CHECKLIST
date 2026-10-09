import { useEffect, useState } from "react";
import type { ChecklistKind } from "../domain/checklist";
import { createRepository } from "../services/createRepository";
import type { DeviceRepository } from "../services/deviceRepository";

/** Resolve o repositório do usuário; null enquanto carrega. */
export function useRepository(userId: string, kind: ChecklistKind = "manutencao"): DeviceRepository | null {
  const [repository, setRepository] = useState<DeviceRepository | null>(null);

  useEffect(() => {
    let active = true;
    setRepository(null);
    void createRepository(userId, kind).then((repo) => {
      if (active) setRepository(repo);
    });
    return () => {
      active = false;
    };
  }, [userId, kind]);

  return repository;
}
