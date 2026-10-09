export type UserRole = "admin" | "supervisor" | "tecnico" | "montador" | "colaborador";

/** Ordem em que os papéis aparecem na tela de administração. */
export const ROLES: readonly UserRole[] = ["admin", "supervisor", "tecnico", "montador", "colaborador"];

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  tecnico: "Técnico",
  montador: "Montador",
  // Quem acabou de entrar: não acessa nada até o admin definir o papel.
  colaborador: "Sem função",
};

export type TabId = "checklist" | "montagem" | "registros" | "admin";

/** Supervisor e admin enxergam os checklists de todos. */
export function canReviewAll(role: UserRole): boolean {
  return role === "admin" || role === "supervisor";
}

/** Só o admin atribui papéis. */
export function canManageUsers(role: UserRole): boolean {
  return role === "admin";
}

/** Checklist de manutenção: técnicos (e o admin, para testar e acompanhar). */
export function canDoMaintenance(role: UserRole): boolean {
  return role === "tecnico" || role === "admin";
}

/** Checklist de montagem: montadores (e o admin). */
export function canDoAssembly(role: UserRole): boolean {
  return role === "montador" || role === "admin";
}

/** Abas que o papel pode abrir, na ordem de exibição. */
export function accessibleTabs(role: UserRole): TabId[] {
  const tabs: TabId[] = [];
  if (canDoMaintenance(role)) tabs.push("checklist");
  if (canDoAssembly(role)) tabs.push("montagem");
  if (canReviewAll(role)) tabs.push("registros");
  if (canManageUsers(role)) tabs.push("admin");
  return tabs;
}
