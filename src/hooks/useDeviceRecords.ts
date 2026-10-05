import { useEffect, useState } from "react";
import type { DeviceRecord } from "../domain/device";
import type { DeviceRepository } from "../services/deviceRepository";

interface RecordsState {
  records: DeviceRecord[];
  loaded: boolean;
  failed: boolean;
}

/** Lista de registros em tempo real. */
export function useDeviceRecords(repository: DeviceRepository | null): RecordsState {
  const [state, setState] = useState<RecordsState>({ records: [], loaded: false, failed: false });

  useEffect(() => {
    if (!repository) return;
    return repository.subscribe(
      (records) => setState({ records, loaded: true, failed: false }),
      () => setState((prev) => ({ ...prev, failed: true })),
    );
  }, [repository]);

  return state;
}
