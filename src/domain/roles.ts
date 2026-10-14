export type UserRole = "admin" | "supervisor" | "tecnico" | "desmontador" | "montador" | "colaborador";

/** Ordem em que os papéis aparecem na tela de administração. */
export const ROLES: readonly UserRole[] = ["admin", "supervisor", "tecnico", "desmontador", "montador", "colaborador"];

/** Papéis de operação que podem ser somados ao papel principal. */
export const EXTRA_ROLES: readonly UserRole[] = ["tecnico", "desmontador", "montador"];

/** Um papel ou a lista de papéis de uma pessoa (principal + extras). */
export type Roles = UserRole | readonly UserRole[];

const hasRole = (roles: Roles, ...wanted: UserRole[]): boolean =>
  (typeof roles === "string" ? [roles] : roles).some((role) => wanted.includes(role));

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  tecnico: "Técnico",
  desmontador: "Desmontador",
  montador: "Montador",
  // Quem acabou de entrar: não acessa nada até o admin definir o papel.
  colaborador: "Sem função",
};

export type TabId =
  | "checklist"
  | "desmontagem"
  | "desmontagem_tecnica"
  | "montagem"
  | "quarentena"
  | "registros"
  | "admin";

/** Supervisor e admin enxergam os checklists de todos. */
export function canReviewAll(role: Roles): boolean {
  return hasRole(role, "admin", "supervisor");
}

/** Só o admin atribui papéis. */
export function canManageUsers(role: Roles): boolean {
  return hasRole(role, "admin");
}

/** Checklist de manutenção: técnicos (e o admin, para testar e acompanhar). */
export function canDoMaintenance(role: Roles): boolean {
  return hasRole(role, "tecnico", "admin");
}

/** Desmontagem e desmontagem técnica: desmontadores (e o admin). */
export function canDoDisassembly(role: Roles): boolean {
  return hasRole(role, "desmontador", "admin");
}

/** Checklist de montagem: montadores (e o admin). */
export function canDoAssembly(role: Roles): boolean {
  return hasRole(role, "montador", "admin");
}

/** Abas que o papel pode abrir, na ordem de exibição. */
export function accessibleTabs(role: Roles): TabId[] {
  const tabs: TabId[] = [];
  if (canDoMaintenance(role)) tabs.push("checklist");
  if (canDoDisassembly(role)) tabs.push("desmontagem", "desmontagem_tecnica");
  if (canDoAssembly(role)) tabs.push("montagem");
  if (canDoAssembly(role)) tabs.push("quarentena");
  if (canReviewAll(role)) tabs.push("registros");
  if (canManageUsers(role)) tabs.push("admin");
  return tabs;
}
