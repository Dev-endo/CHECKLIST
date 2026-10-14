import type { UserRole } from "../../domain/roles";
import type { AppSupabaseClient } from "./client";

export interface Profile {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** Papéis de operação somados ao principal. */
  extraRoles: UserRole[];
  createdAt: string;
}

export async function fetchProfile(client: AppSupabaseClient, id: string): Promise<Profile | null> {
  const { data, error } = await client.from("profiles").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data && toProfile(data);
}

/** Todos os usuários; só retorna mais que o próprio perfil para supervisor e admin. */
export async function fetchProfiles(client: AppSupabaseClient): Promise<Profile[]> {
  const { data, error } = await client.from("profiles").select("*").order("created_at", { ascending: true });
  if (error) throw error;
  return data.map(toProfile);
}

/** Só o admin consegue, e nunca na própria conta (política RLS). */
export async function updateRole(client: AppSupabaseClient, id: string, role: UserRole): Promise<void> {
  const { data, error } = await client.from("profiles").update({ role }).eq("id", id).select("id");
  if (error) throw error;
  // RLS nega sem erro: nenhuma linha atualizada.
  if (!data.length) throw new Error("Sem permissão para alterar este usuário");
}

/** Só o admin consegue, e nunca na própria conta (política RLS). */
export async function updateExtraRoles(client: AppSupabaseClient, id: string, extraRoles: UserRole[]): Promise<void> {
  const { data, error } = await client.from("profiles").update({ extra_roles: extraRoles }).eq("id", id).select("id");
  if (error) throw error;
  if (!data.length) throw new Error("Sem permissão para alterar este usuário");
}

function toProfile(row: {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  extra_roles?: UserRole[];
  created_at: string;
}): Profile {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    extraRoles: row.extra_roles ?? [],
    createdAt: row.created_at,
  };
}
