import { useEffect, useState } from "react";
import { createRepository } from "../services/createRepository";
import type { DeviceRepository } from "../services/deviceRepository";

/** Resolve o repositório uma vez; null enquanto carrega. */
export function useRepository(): DeviceRepository | null {
  const [repository, setRepository] = useState<DeviceRepository | null>(null);

  useEffect(() => {
    let active = true;
    void createRepository().then((repo) => {
      if (active) setRepository(repo);
    });
    return () => {
      active = false;
    };
  }, []);

  return repository;
}
