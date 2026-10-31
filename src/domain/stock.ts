import { MAINTENANCE_ITEMS } from "./maintenance";

/** Manutenções que não usam peça do estoque. */
const WITHOUT_PART: readonly string[] = ["Limpeza", "Software"];

/** Manutenções que não usam peça do estoque (continuam como opção avulsa no balão do técnico). */
export const NON_PART_ITEMS: readonly string[] = WITHOUT_PART;

/** Peças que o estoquista pode alocar: as manutenções do aparelho, menos as que não usam peça. */
export const STOCK_PARTS: readonly string[] = MAINTENANCE_ITEMS.filter((item) => !WITHOUT_PART.includes(item));

/** liberada: a peça alocada pelo estoquista já está no aparelho, com o técnico. */
export type AllocationStatus = "liberada" | "concluida" | "devolvida" | "trocada";

export const ALLOCATION_LABELS: Record<AllocationStatus, string> = {
  liberada: "Alocada no aparelho",
  concluida: "Concluída",
  devolvida: "Devolvida",
  trocada: "Trocada",
};

export function parseAllocationStatus(value: unknown): AllocationStatus {
  return value === "concluida" || value === "devolvida" || value === "trocada" ? value : "liberada";
}

/** Peças que ainda estão com o técnico (sem concluir, devolver ou trocar). */
export function openParts<T extends { status: AllocationStatus }>(allocations: readonly T[]): T[] {
  return allocations.filter((allocation) => allocation.status === "liberada");
}

/** O que o técnico (ou desmontador) pede ao estoque. */
/** uso e devolucao: o técnico decide o que fazer com a peça de teste emprestada. */
export type RequestKind = "nova" | "teste" | "troca" | "uso" | "devolucao";

export function parseRequestKind(value: unknown): RequestKind {
  return value === "teste" || value === "troca" || value === "uso" || value === "devolucao" ? value : "nova";
}

/** Aviso mostrado ao estoquista quando alguém pede uma peça. */
export function requestMessage(requester: string, kind: RequestKind): string {
  if (kind === "teste") return `${requester} solicitou peça para teste`;
  if (kind === "troca") return `${requester} solicitou troca de peça`;
  if (kind === "uso") return `${requester} pediu liberação da peça de teste para uso`;
  if (kind === "devolucao") return `${requester} devolveu a peça de teste`;
  return `${requester} solicitou peça para manutenção`;
}

/** Quem decide a troca é o estoquista: a peça estava ruim ou foi erro técnico. */
export type SwapDecision = "peca_ruim" | "erro_tecnico";

export const SWAP_DECISIONS: readonly { id: SwapDecision; label: string }[] = [
  { id: "peca_ruim", label: "Peça ruim" },
  { id: "erro_tecnico", label: "Erro técnico" },
];

/** Decisão do técnico sobre uma peça alocada ao concluir o checklist. */
export type AllocationAction = "concluir" | "devolver";

/** Manutenções (itens) das peças que o técnico concluiu, na ordem do catálogo. */
export function sortByCatalog<T extends { item: string }>(maintenances: readonly T[]): T[] {
  const order = (name: string) => MAINTENANCE_ITEMS.indexOf(name as (typeof MAINTENANCE_ITEMS)[number]);
  return [...maintenances].sort((a, b) => order(a.item) - order(b.item));
}

/** Peças alocadas ainda sem decisão do técnico (nem concluir, nem devolver, nem troca pedida). */
export function undecidedParts<T extends { id: string }>(
  open: readonly T[],
  choices: Readonly<Record<string, AllocationAction | undefined>>,
  swapping: ReadonlySet<string>,
): T[] {
  return open.filter((part) => !choices[part.id] && !swapping.has(part.id));
}

/** Pedido de peça que o estoquista ainda não respondeu: o checklist de manutenção não conclui até ele liberar a peça. */
export function requestBlocksConclusion(requests: readonly { kind: RequestKind }[]): boolean {
  return requests.some((request) => request.kind === "nova" || request.kind === "teste" || request.kind === "troca");
}

/** Peça de teste emprestada: enquanto estiver com o técnico, o checklist de manutenção não conclui. */
export function testPartBlocksConclusion(loans: readonly { status: string }[]): boolean {
  return loans.some((loan) => loan.status === "emprestada");
}

/** Uma peça trocada por decisão do estoquista, com o técnico que pediu a troca. */
export interface SwappedPart {
  reason: SwapDecision;
  part: string;
  model: string | null;
  person: string;
  userId: string;
  at: string;
}

/** Modelo sem a memória: "iPhone 15 Pro 256GB" vira "iPhone 15 Pro". */
export function modelWithoutMemory(model: string | null): string {
  const name = (model ?? "").replace(/\s*\b\d+\s*(?:GB|TB)\b/gi, "").replace(/\s{2,}/g, " ").trim();
  return name || "Modelo não encontrado";
}

export interface SwapCount {
  part: string;
  model: string;
  count: number;
}

/** Quantas peças foram trocadas, por peça e modelo (sem a memória), da maior quantidade para a menor. */
export function countSwaps(rows: readonly Pick<SwappedPart, "part" | "model">[]): SwapCount[] {
  const counts = new Map<string, SwapCount>();
  for (const row of rows) {
    const model = modelWithoutMemory(row.model);
    const key = `${row.part}|${model}`;
    const found = counts.get(key);
    if (found) found.count += 1;
    else counts.set(key, { part: row.part, model, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.part.localeCompare(b.part) || a.model.localeCompare(b.model));
}

export interface PersonSwaps {
  person: string;
  total: number;
  counts: SwapCount[];
}

/** O mesmo, separado por técnico: quem errou mais vem primeiro. */
export function countSwapsByPerson(rows: readonly SwappedPart[]): PersonSwaps[] {
  const people = new Map<string, SwappedPart[]>();
  for (const row of rows) people.set(row.userId, [...(people.get(row.userId) ?? []), row]);
  return [...people.values()]
    .map((own) => ({ person: own[0]?.person ?? "—", total: own.length, counts: countSwaps(own) }))
    .sort((a, b) => b.total - a.total || a.person.localeCompare(b.person));
}
