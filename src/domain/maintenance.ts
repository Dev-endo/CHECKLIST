/** Manutenções que podem ter sido feitas no aparelho, na ordem em que aparecem na tela. */
export const MAINTENANCE_ITEMS = [
  "Alto-falante",
  "Aro",
  "Auricular",
  "Bateria",
  "Bobina NFC",
  "Botão volume",
  "Botão power",
  "Câmera frontal",
  "Câmera traseira",
  "Carcaça",
  "Conector de carga",
  "Display",
  "Face ID",
  "Flash",
  "Fio",
  "Flex Proximidade",
  "Gaveta de chip",
  "Laminação",
  "Lente da câmera",
  "Limpeza",
  "Microfone conector de carga",
  "Microfone câmera",
  "Placa",
  "PT",
  "Software",
  "Tampa",
  "Vibracall",
] as const;

/** Manutenção que pede detalhar o serviço feito. */
export const PLACA_ITEM = "Placa";

/**
 * Serviços possíveis na placa. Enquanto esta lista estiver vazia, o detalhe é
 * digitado em um campo de texto; com itens, vira uma lista de seleção.
 */
export const PLACA_SERVICES: readonly string[] = [];

/** Para onde o aparelho vai depois da manutenção, quando o checklist sai todo OK. */
/** "analise": checklist reprovado enviado para análise técnica (sem isso, continua em manutenção). */
export type Destination = "montagem" | "vidro" | "analise";

export const DESTINATIONS: readonly { id: Destination; label: string }[] = [
  { id: "montagem", label: "Liberado para montagem" },
  // Vidro é uma etapa da manutenção: o aparelho só sai dela quando vai para a montagem.
  { id: "vidro", label: "Enviado para vidro" },
];

/** Escolha de um checklist reprovado que segue para análise técnica. */
export const ANALYSIS_LABEL = "Enviado para análise técnica";

export function destinationLabel(destination: Destination): string {
  if (destination === "analise") return ANALYSIS_LABEL;
  return DESTINATIONS.find((d) => d.id === destination)?.label ?? destination;
}

export function parseDestination(value: unknown): Destination | undefined {
  return value === "montagem" || value === "vidro" || value === "analise" ? value : undefined;
}

/** De quem foi o erro de um aparelho reprovado na montagem. */
export type Blame = "montagem" | "manutencao";

export const BLAMES: readonly { id: Blame; label: string }[] = [
  { id: "montagem", label: "Erro de montagem" },
  { id: "manutencao", label: "Erro de manutenção" },
];

export function blameLabel(blame: Blame): string {
  return BLAMES.find((b) => b.id === blame)?.label ?? blame;
}

export function parseBlame(value: unknown): Blame | undefined {
  return value === "montagem" || value === "manutencao" ? value : undefined;
}

export interface Maintenance {
  item: string;
  /** Só na placa: qual serviço foi feito. */
  detail?: string;
}

/** Marca ou desmarca uma manutenção, mantendo a ordem da lista. */
export function toggleMaintenance(selected: readonly Maintenance[], item: string): Maintenance[] {
  if (selected.some((m) => m.item === item)) return selected.filter((m) => m.item !== item);
  const order = (name: string) => MAINTENANCE_ITEMS.indexOf(name as (typeof MAINTENANCE_ITEMS)[number]);
  return [...selected, { item }].sort((a, b) => order(a.item) - order(b.item));
}

export function setMaintenanceDetail(selected: readonly Maintenance[], item: string, detail: string): Maintenance[] {
  return selected.map((m) => (m.item === item ? { ...m, detail } : m));
}

/** Placa marcada exige dizer o que foi feito nela. */
export function isMaintenanceComplete(selected: readonly Maintenance[]): boolean {
  return selected.every((m) => m.item !== PLACA_ITEM || (m.detail ?? "").trim() !== "");
}

export function describeMaintenance(maintenance: Maintenance): string {
  const detail = maintenance.detail?.trim();
  return detail ? `${maintenance.item}: ${detail}` : maintenance.item;
}

/** Lê o que veio do banco (jsonb), ignorando o que não tiver o formato esperado. */
export function parseMaintenances(value: unknown): Maintenance[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { item, detail } = entry as { item?: unknown; detail?: unknown };
    if (typeof item !== "string" || !item) return [];
    return [typeof detail === "string" && detail ? { item, detail } : { item }];
  });
}
