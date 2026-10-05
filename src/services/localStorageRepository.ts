import type { DeviceDoc, DeviceRecord } from "../domain/device";
import { RECORDS_LIMIT, type DeviceRepository } from "./deviceRepository";

const STORAGE_KEY = "checklist-iphone-registros";

type Store = Record<string, DeviceDoc>;

/** Persistência só neste navegador, para quando o app roda fora do artifact. */
export class LocalStorageRepository implements DeviceRepository {
  readonly kind = "local";
  private readonly listeners = new Set<(records: DeviceRecord[]) => void>();

  subscribe(onChange: (records: DeviceRecord[]) => void, onError: (error: unknown) => void) {
    const emit = () => {
      try {
        onChange(this.list());
      } catch (error) {
        onError(error);
      }
    };
    // Mantém abas abertas em sincronia.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) emit();
    };
    this.listeners.add(onChange);
    window.addEventListener("storage", onStorage);
    emit();
    return () => {
      this.listeners.delete(onChange);
      window.removeEventListener("storage", onStorage);
    };
  }

  async save(id: string, doc: DeviceDoc) {
    const store = this.read();
    store[id] = doc;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    const records = this.list();
    this.listeners.forEach((listener) => listener(records));
  }

  private read(): Store {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Store;
  }

  private list(): DeviceRecord[] {
    return Object.entries(this.read())
      .map(([id, doc]) => ({ ...doc, id }))
      .sort((a, b) => (b.atualizado ?? "").localeCompare(a.atualizado ?? ""))
      .slice(0, RECORDS_LIMIT);
  }
}
