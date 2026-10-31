import type { TabId } from "./roles";

/** Grupo do menu: um botão no topo e, dentro dele, as abas que a pessoa pode abrir. */
export interface NavGroup {
  id: string;
  label: string;
  /** Só as abas a que a pessoa tem acesso, na ordem do grupo; a primeira abre ao clicar no grupo. */
  tabs: TabId[];
}

const GROUPS: { id: string; label: string; tabs: readonly TabId[] }[] = [
  { id: "reparo", label: "Reparo", tabs: ["reparo", "reparo2"] },
  // Uma aba só para a quarentena, aberta para todos (aguardando, registrar e seriais de hoje).
  { id: "quarentena", label: "Quarentena", tabs: ["quarentena"] },
  { id: "analise_tecnica", label: "Análise técnica", tabs: ["analise_tecnica", "reparo_placa", "analise_montagem"] },
  { id: "vidro", label: "Vidro", tabs: ["vidro"] },
  // A consulta de OS fica em Estoque.
  { id: "estoque", label: "Estoque", tabs: ["solicitacoes", "os"] },
  { id: "analise", label: "Análise", tabs: ["dashboard"] },
  { id: "admin", label: "Administração", tabs: ["admin"] },
];

/** Nome da aba dentro do grupo (a sub-aba). */
export const TAB_LABELS: Record<TabId, string> = {
  reparo: "Estágio 1",
  reparo2: "Estágio 2",
  analise_tecnica: "Análise",
  reparo_placa: "Reparo em placa",
  analise_montagem: "Checklist e montagem",
  vidro: "Vidro",
  checklist: "Checklist de manutenção",
  os: "Ordens de serviço",
  solicitacoes: "Solicitações de peça",
  estoque: "Alocar peças",
  emprestimos: "Peças emprestadas",
  desmontagem: "Desmontagem",
  desmontagem_tecnica: "Desmontagem técnica",
  montagem: "Montagem",
  quarentena: "Quarentena",
  registros: "Análise (antiga)",
  dashboard: "Análise",
  admin: "Administração",
};

/**
 * Agrupa as abas acessíveis no menu. Quem não tem a aba principal de um grupo, mas tem uma aba dele
 * (ex.: registrar OS sem fazer manutenção), vê essa aba sozinha no topo, com o nome dela.
 */
export function navGroups(accessible: readonly TabId[]): NavGroup[] {
  const groups = GROUPS.flatMap<NavGroup & { standalone: boolean }>((group) => {
    const tabs = group.tabs.filter((tab) => accessible.includes(tab));
    if (!tabs.length) return [];
    const [first] = tabs;
    const standalone = tabs.length === 1 && first !== group.tabs[0];
    return [{ id: group.id, label: standalone ? TAB_LABELS[first as TabId] : group.label, tabs, standalone }];
  });
  // As abas soltas (ex.: Registrar OS de quem não faz manutenção) ficam por último.
  return [...groups.filter((g) => !g.standalone), ...groups.filter((g) => g.standalone)].map(({ standalone: _s, ...group }) => group);
}
