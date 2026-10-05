import { ClaudeDbRepository, getClaudeDb } from "./claudeDbRepository";
import type { DeviceRepository } from "./deviceRepository";
import { LocalStorageRepository } from "./localStorageRepository";

/** Usa o banco compartilhado do artifact quando existir; senão, o navegador. */
export async function createRepository(): Promise<DeviceRepository> {
  const db = await getClaudeDb();
  return db ? new ClaudeDbRepository(db) : new LocalStorageRepository();
}
