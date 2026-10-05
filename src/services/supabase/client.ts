import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

export type AppSupabaseClient = SupabaseClient<Database>;

let client: AppSupabaseClient | null | undefined;

/** Cliente único do Supabase, ou null se as variáveis de ambiente não estiverem definidas. */
export function getSupabaseClient(): AppSupabaseClient | null {
  if (client !== undefined) return client;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  client =
    url && key
      ? // Sem login: não há sessão para guardar nem renovar.
        createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
      : null;
  return client;
}
