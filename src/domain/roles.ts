export type UserRole =
  | "admin"
  | "supervisor"
  | "tecnico"
  | "desmontador"
  | "montador"
  | "estoquista"
  | "analista"
  | "tecnico_vidro"
  | "colaborador";

/** Ordem em que os papéis aparecem na tela de administração. */
export const ROLES: readonly UserRole[] = [
  "admin",
  "supervisor",
  "tecnico",
  "desmontador",
  "montador",
  "estoquista",
  "analista",
  "tecnico_vidro",
  "colaborador",
];

/**
 * Papéis que o admin escolhe na tela de Administração. Desmontador e Montador são do fluxo antigo: só aparecem para
 * quem ainda os tem.
 */
export const ADMIN_ROLES: readonly UserRole[] = ["admin", "supervisor", "tecnico", "analista", "tecnico_vidro", "estoquista", "colaborador"];

/** Funções que podem ser somadas ao papel principal (uma pessoa pode ter mais de uma). */
export const EXTRA_ROLES: readonly UserRole[] = ["tecnico", "analista", "tecnico_vidro", "estoquista", "supervisor"];

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
  estoquista: "Estoquista",
  analista: "Técnico de placa",
  tecnico_vidro: "Técnico de vidro",
  // Quem acabou de entrar: não acessa nada até o admin definir o papel.
  colaborador: "Sem função",
};

export type TabId =
  | "reparo"
  | "reparo2"
  | "vidro"
  | "analise_tecnica"
  | "reparo_placa"
  | "analise_montagem"
  | "checklist"
  | "desmontagem"
  | "desmontagem_tecnica"
  | "montagem"
  | "quarentena"
  | "solicitacoes"
  | "estoque"
  | "emprestimos"
  | "os"
  | "registros"
  | "dashboard"
  | "admin";

/** Supervisor e admin enxergam os checklists de todos. */
export function canReviewAll(role: Roles): boolean {
  return hasRole(role, "admin", "supervisor");
}

/** Só o admin atribui papéis. */
export function canManageUsers(role: Roles): boolean {
  return hasRole(role, "admin");
}

/** Aba Reparo (estágio 1: OS, desmontagem, análise básica e pedido de peça): o técnico (e o admin). */
export function canDoRepair(role: Roles): boolean {
  return hasRole(role, "tecnico", "admin");
}

/** Checklist de manutenção: técnicos (e o admin, para testar e acompanhar). */
export function canDoMaintenance(role: Roles): boolean {
  return hasRole(role, "tecnico", "admin");
}

/** Desmontagem e desmontagem técnica: desmontadores (e o admin). */
export function canDoDisassembly(role: Roles): boolean {
  return hasRole(role, "desmontador", "admin");
}

/** Aba Estoque: alocar peças nos aparelhos (na OS atual). Só o estoquista (e o admin). */
export function canManageStock(role: Roles): boolean {
  return hasRole(role, "estoquista", "admin");
}

/** Só o admin corrige o número de uma OS registrada errada. */
export function canCorrectOs(role: Roles): boolean {
  return hasRole(role, "admin");
}

/** Registrar a OS do ativo, no campo da desmontagem ou do reparo: desmontador e técnico (e o admin). */
export function canRegisterOs(role: Roles): boolean {
  return hasRole(role, "desmontador", "tecnico", "admin");
}

/** Consultar as OS e o caminho de cada aparelho nelas (fica dentro de Estoque). */
export function canViewOs(role: Roles): boolean {
  return hasRole(role, "admin", "estoquista");
}

/** Aba Análise (painel de resultados): supervisor e admin. */
export function canSeeDashboard(role: Roles): boolean {
  return hasRole(role, "admin", "supervisor");
}

/**
 * Avisos do estoque (solicitação nova, devolução): só quem tem a função de estoquista. O admin vê todas as abas, mas
 * só recebe aviso das funções atribuídas a ele.
 */
export function receivesStockAlerts(role: Roles): boolean {
  return hasRole(role, "estoquista");
}

/** Aba Quarentena: todo mundo que tem função (só quem está "Sem função" fica de fora). */
export function canUseQuarantine(role: Roles): boolean {
  return hasRole(role, "admin", "supervisor", "tecnico", "desmontador", "montador", "estoquista", "analista", "tecnico_vidro");
}

/** Aba Vidro: o técnico de vidro (e o admin). */
export function canDoGlass(role: Roles): boolean {
  return hasRole(role, "tecnico_vidro", "admin");
}

/** Aba Análise técnica: o analista (e o admin). */
export function canDoAnalysis(role: Roles): boolean {
  return hasRole(role, "analista", "admin");
}

/** Checklist de montagem: montadores (e o admin). */
export function canDoAssembly(role: Roles): boolean {
  return hasRole(role, "montador", "admin");
}

/** Abas que o papel pode abrir, na ordem de exibição. */
export function accessibleTabs(role: Roles): TabId[] {
  const tabs: TabId[] = [];
  // Técnico: Reparo. Técnico de placa: Análise técnica. Técnico de vidro: Vidro. Estoquista: Estoque.
  // Supervisor: Análise. Todos: Quarentena. Admin: tudo.
  if (canDoRepair(role)) tabs.push("reparo", "reparo2");
  if (canUseQuarantine(role)) tabs.push("quarentena");
  if (canDoAnalysis(role)) tabs.push("analise_tecnica", "reparo_placa", "analise_montagem");
  if (canDoGlass(role)) tabs.push("vidro");
  if (canManageStock(role)) tabs.push("solicitacoes");
  if (canViewOs(role)) tabs.push("os");
  if (canSeeDashboard(role)) tabs.push("dashboard");
  if (canManageUsers(role)) tabs.push("admin");
  return tabs;
}
