import type { DeviceDoc, DeviceRecord } from "../domain/device";
import { RECORDS_LIMIT, ReadOnlyError, type DeviceRepository } from "./deviceRepository";

/** Subconjunto da API `window.claude.use("db")` usada aqui. */
interface ClaudeDocSnapshot {
  id: string;
  exists: boolean;
  data(): unknown;
}
interface ClaudeQuery {
  orderBy(field: string, direction: "asc" | "desc"): ClaudeQuery;
  limit(n: number): ClaudeQuery;
  onSnapshot(
    onNext: (snap: { docs: ClaudeDocSnapshot[] }) => void,
    onError: (error: unknown) => void,
  ): (() => void) | undefined;
}
export interface ClaudeDb {
  doc(path: string): { set(data: unknown): Promise<void> };
  collection(name: string): ClaudeQuery;
}

declare global {
  interface Window {
    claude?: { use?: (capability: "db") => Promise<ClaudeDb | null | undefined> };
  }
}

const COLLECTION = "aparelhos";

/** Retorna o banco do artifact do claude.ai, ou null fora desse ambiente. */
export async function getClaudeDb(): Promise<ClaudeDb | null> {
  try {
    return (await window.claude?.use?.("db")) ?? null;
  } catch {
    return null;
  }
}

export class ClaudeDbRepository implements DeviceRepository {
  readonly kind = "shared";

  constructor(private readonly db: ClaudeDb) {}

  subscribe(onChange: (records: DeviceRecord[]) => void, onError: (error: unknown) => void) {
    const unsubscribe = this.db
      .collection(COLLECTION)
      .orderBy("atualizado", "desc")
      .limit(RECORDS_LIMIT)
      .onSnapshot((snap) => {
        onChange(
          snap.docs
            .filter((d) => d.exists)
            // Cópia profunda em JSON puro: o snapshot pode conter objetos não clonáveis.
            .map((d) => ({ ...(JSON.parse(JSON.stringify(d.data() ?? {})) as Partial<DeviceDoc>), id: d.id })),
        );
      }, onError);
    return () => unsubscribe?.();
  }

  async save(id: string, doc: DeviceDoc) {
    try {
      await this.db.doc(`${COLLECTION}/${id}`).set(doc);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "invalid_argument") throw new ReadOnlyError();
      throw error;
    }
  }
}
