import { ClaudeDbRepository, getClaudeDb } from "./claudeDbRepository";
import type { DeviceRepository } from "./deviceRepository";
import { LocalStorageRepository } from "./localStorageRepository";
import { getSupabaseClient } from "./supabase/client";
import { SupabaseRepository } from "./supabase/supabaseRepository";

/**
 * Escolhe onde gravar, em ordem: Supabase (se configurado no .env),
 * banco do artifact do claude.ai, ou só este navegador.
 */
export async function createRepository(): Promise<DeviceRepository> {
  const supabase = getSupabaseClient();
  if (supabase) return new SupabaseRepository(supabase);

  const db = await getClaudeDb();
  return db ? new ClaudeDbRepository(db) : new LocalStorageRepository();
}
