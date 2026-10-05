import type { DeviceDoc, DeviceRecord } from "../domain/device";

export const RECORDS_LIMIT = 300;

/** Fonte dos registros de aparelhos, independente de onde ficam gravados. */
export interface DeviceRepository {
  /** "shared": banco compartilhado do artifact; "local": só neste navegador. */
  readonly kind: "shared" | "local";
  /** Registros mais recentes primeiro. Retorna a função de cancelamento. */
  subscribe(onChange: (records: DeviceRecord[]) => void, onError: (error: unknown) => void): () => void;
  save(id: string, doc: DeviceDoc): Promise<void>;
}

/** O usuário pode ler os registros, mas não gravar. */
export class ReadOnlyError extends Error {
  constructor() {
    super("Sem permissão de escrita");
    this.name = "ReadOnlyError";
  }
}
