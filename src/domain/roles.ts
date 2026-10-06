export type UserRole = "admin" | "supervisor" | "colaborador";

export const ROLES: readonly UserRole[] = ["admin", "supervisor", "colaborador"];

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  colaborador: "Colaborador",
};

/** Supervisor e admin enxergam os checklists de todos. */
export function canReviewAll(role: UserRole): boolean {
  return role === "admin" || role === "supervisor";
}

/** Só o admin atribui papéis. */
export function canManageUsers(role: UserRole): boolean {
  return role === "admin";
}
