import { buildCatalog, CHECKLIST, MISSING_PARTS_BLOCKS, type ChecklistBlock, type ChecklistKind } from "./checklist";
import { isConfirmed, type Results, type TestResult } from "./device";
import { isOpenRequest, type RequestPurpose, type RequestStatus, type TestDestiny } from "./repairStages";

/** Fases dos testes da manutenção: com o aparelho fechado e com o aparelho aberto. */
export type ChecklistPhase = "aberto" | "fechado";

export const PHASES: readonly ChecklistPhase[] = ["aberto", "fechado"];

export const PHASE_LABELS: Record<ChecklistPhase, string> = {
  aberto: "Testes com o aparelho aberto",
  fechado: "Testes com o aparelho fechado",
};

/** As duas fases usam os testes do checklist de manutenção (inclusive apontar o item que falhou). */
export const PHASE_KIND: Record<ChecklistPhase, ChecklistKind> = { aberto: "manutencao", fechado: "manutencao" };

/** Chave, dentro do que é gravado, da saúde da bateria (não é resultado de teste). */
export const BATTERY_KEY = "_bateria";

/**
 * "Faltando parafuso" e "Faltando blindagem": perguntas do Estágio 1 (a pessoa vê o ativo ao desmontar),
 * respondidas na desmontagem. Sim ou Não; não reprova nada.
 */
export const MISSING_PARTS_CATALOG: readonly ChecklistBlock[] = buildCatalog(MISSING_PARTS_BLOCKS);

// Catálogos da manutenção -----------------------------------------------------------------------------------------
// Display, proximidade, câmeras e microfones são testados com o aparelho fechado E com ele aberto.
// Todos os outros testes, só com o aparelho aberto. Os testes são os do checklist de manutenção; onde um tópico
// misturava grupos (sensores, áudio), ele foi dividido sem mudar o texto dos testes.

const maintenanceBlock = (id: string): ChecklistBlock => {
  const found = CHECKLIST.find((block) => block.id === id);
  if (!found) throw new Error(`Tópico ${id} não existe no checklist de manutenção`);
  return found;
};

const itemsOf = (blockId: string, itemIds: readonly string[]) => maintenanceBlock(blockId).items.filter((item) => itemIds.includes(item.id));

const { id: _display, ...DISPLAY } = maintenanceBlock("tela-e-touch");
const { id: _cameras, ...CAMERAS } = maintenanceBlock("cameras");
const { id: _connectivity, ...CONNECTIVITY } = maintenanceBlock("conectividade-e-carga");
const { id: _buttons, ...BUTTONS } = maintenanceBlock("botoes-e-vibracao");
const { id: _system, ...SYSTEM } = maintenanceBlock("sistema");

/** Testes feitos nas duas fases. */
const SHARED = [
  DISPLAY,
  { title: "Sensor de proximidade", items: itemsOf("sensores-e-biometria", ["prox"]) },
  CAMERAS,
  { title: "Microfones", items: itemsOf("audio-e-microfones", ["mic-inf", "mic-tras", "mic-front"]) },
];

/** Testes só com o aparelho aberto. */
const OPEN_ONLY = [
  { title: "Face ID, Touch ID e NFC", items: itemsOf("sensores-e-biometria", ["faceid", "nfc"]) },
  { title: "Auricular e alto-falante", items: itemsOf("audio-e-microfones", ["auricular", "altofalante"]) },
  CONNECTIVITY,
  BUTTONS,
  SYSTEM,
];

const CLOSED_CATALOG: readonly ChecklistBlock[] = buildCatalog(SHARED);
const OPEN_CATALOG: readonly ChecklistBlock[] = buildCatalog([...SHARED, ...OPEN_ONLY]);

/** Tópicos de cada fase. */
export const phaseCatalog = (phase: ChecklistPhase): readonly ChecklistBlock[] => (phase === "aberto" ? OPEN_CATALOG : CLOSED_CATALOG);

/** Marca ou desmarca o resultado de um tópico da fase; sair de "Falha" limpa os itens apontados. */
export function toggleBlockResult(results: Results, block: ChecklistBlock, result: TestResult): Results {
  const next: TestResult | "" = results[block.id] === result ? "" : result;
  const updated: Results = { ...results, [block.id]: next };
  if (next !== "fail") for (const item of block.items) delete updated[item.id];
  return updated;
}

/** Confirmações obrigatórias da fase (ex.: IMEI) ainda não marcadas. */
export const missingPhaseConfirmations = (phase: ChecklistPhase, results: Results) =>
  phaseCatalog(phase)
    .flatMap((block) => block.items)
    .filter((item) => item.field === "confirm" && !isConfirmed(results, item.id));

/** Tópicos que recebem OK ou Falha na fase (os que só têm caixa de confirmação não entram). */
export const requiredTests = (phase: ChecklistPhase): string[] =>
  phaseCatalog(phase)
    .filter((block) => !block.confirmOnly)
    .map((block) => block.id);

/** Tópicos de escolha (ex.: original ou paralelo): a segunda resposta não é falha. */
export const choiceTests = (phase: ChecklistPhase): string[] =>
  phaseCatalog(phase)
    .filter((block) => block.choice)
    .map((block) => block.id);

/** Perguntas de peças faltando ainda sem resposta (a desmontagem só conclui com as duas respondidas). */
export const missingPartsPending = (results: Results): number => MISSING_PARTS_CATALOG.filter((block) => !results[block.id]).length;

/** O que se grava no banco por fase: os resultados mais a bateria (quando informada). */
export function toSaved(results: Results, battery: number | undefined): Record<string, unknown> {
  return battery === undefined ? { ...results } : { ...results, [BATTERY_KEY]: battery };
}

/** Lê o que veio do banco (jsonb), separando a bateria dos resultados. */
export function fromSaved(value: unknown): { results: Results; battery: number | undefined } {
  const results: Results = {};
  let battery: number | undefined;
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === BATTERY_KEY) {
        if (typeof entry === "number") battery = entry;
      } else if (entry === "ok" || entry === "fail") {
        results[key] = entry;
      }
    }
  }
  return { results, battery };
}

/** Testes obrigatórios da fase ainda sem resposta (confirmações obrigatórias entram à parte). */
export function pendingTests(phase: ChecklistPhase, results: Results): string[] {
  return requiredTests(phase).filter((id) => !results[id]);
}

/** Destino escolhido ao finalizar: automático (quarentena ou análise pelos testes), vidro ou revenda. */
export type FinishDestination = "auto" | "vidro" | "revenda";

export interface FinishInput {
  results: Record<ChecklistPhase, Results>;
  requests: readonly { status: RequestStatus; purpose: RequestPurpose; testDestiny: TestDestiny | null }[];
  returnsWaiting: number;
  destination: FinishDestination;
  resaleReason: string;
}

/**
 * O que ainda impede finalizar a manutenção, em português. A conferência de verdade é do banco; esta lista
 * só mostra ao técnico o que falta antes de ele clicar.
 */
export function finishBlockers(input: FinishInput): string[] {
  const blockers: string[] = [];
  for (const phase of PHASES) {
    const missing = pendingTests(phase, input.results[phase]).length;
    if (missing) blockers.push(`${PHASE_LABELS[phase]}: faltam ${missing} teste(s) obrigatório(s)`);
    const confirmations = missingPhaseConfirmations(phase, input.results[phase]);
    if (confirmations.length) blockers.push(`${PHASE_LABELS[phase]}: confirme ${confirmations.map((item) => item.title).join(", ")}`);
  }
  const open = input.requests.filter((r) => isOpenRequest(r.status)).length;
  if (open) blockers.push(`${open} solicitação(ões) de peça ainda em aberto: aguarde o estoque ou cancele`);
  const noDestiny = input.requests.filter((r) => r.purpose === "teste" && r.status === "entregue" && !r.testDestiny).length;
  if (noDestiny) blockers.push(`${noDestiny} peça(s) de teste entregue(s) sem destino: utilize ou devolva`);
  if (input.returnsWaiting) blockers.push(`${input.returnsWaiting} devolução(ões) aguardando o estoque confirmar o recebimento`);
  if (input.destination === "revenda" && input.resaleReason.trim().length < 5) blockers.push("Revenda exige uma justificativa");
  return blockers;
}

/** Para onde o aparelho vai ao finalizar, pelo que está marcado (o banco confirma). */
export function expectedOutcome(
  results: Record<ChecklistPhase, Results>,
  destination: FinishDestination,
): "quarentena" | "analise" | "revenda" | "vidro" {
  if (destination === "revenda") return "revenda";
  if (destination === "vidro") return "vidro";
  const failed = PHASES.some((phase) => {
    const choice = new Set(choiceTests(phase));
    return requiredTests(phase).some((id) => results[phase][id] === "fail" && !choice.has(id));
  });
  return failed ? "analise" : "quarentena";
}

export const OUTCOME_LABELS = {
  quarentena: "Quarentena",
  vidro: "Vidro",
  analise: "Fila de Análise",
  revenda: "Revenda",
} as const;

// Testes reprovados (o que a manutenção gravou na fila da Análise) ----------------------------------------------

export interface FailedTestEntry {
  fase: ChecklistPhase;
  /** Id do tópico reprovado. */
  teste?: string;
  /** Id do item apontado dentro do tópico. */
  item?: string;
}

/** Lê o jsonb que o banco guarda em failed_tests, ignorando o que não tiver o formato esperado. */
export function parseFailedTests(value: unknown): FailedTestEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap<FailedTestEntry>((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { fase, teste, item } = entry as { fase?: unknown; teste?: unknown; item?: unknown };
    if (fase !== "aberto" && fase !== "fechado") return [];
    if (typeof teste === "string") return [{ fase, teste }];
    if (typeof item === "string") return [{ fase, item }];
    return [];
  });
}

/** "Aparelho fechado: Câmeras" ou "Aparelho fechado: Câmera frontal" (item apontado), com os nomes que o técnico viu. */
export function describeFailedTest(entry: FailedTestEntry): string {
  const where = entry.fase === "aberto" ? "Aparelho aberto" : "Aparelho fechado";
  const catalog = phaseCatalog(entry.fase);
  if (entry.teste) return `${where}: ${catalog.find((block) => block.id === entry.teste)?.title ?? entry.teste}`;
  const title = catalog.flatMap((block) => block.items).find((item) => item.id === entry.item)?.title;
  return `${where}: ${title ?? entry.item ?? "item"}`;
}

// Manutenções que contam ------------------------------------------------------------------------------------------

/** O que o banco devolve: a placa reparada por quem finaliza e cada peça usada de vez. */
export interface MaintenanceItem {
  tipo: "placa" | "peca";
  peca?: string;
  qtd?: number;
  descricao?: string | null;
}

/** Total de manutenções (placa = 1; cada peça = 1 por unidade) e as linhas para mostrar. */
export function summarizeMaintenance(items: readonly MaintenanceItem[]): { count: number; lines: string[] } {
  const lines = items.map((item) => {
    if (item.tipo === "placa") return item.descricao ? `Reparo em placa: ${item.descricao}` : "Reparo em placa";
    const qty = item.qtd ?? 1;
    return qty > 1 ? `${item.peca ?? "Peça"} (${qty})` : (item.peca ?? "Peça");
  });
  const count = items.reduce((total, item) => total + (item.tipo === "placa" ? 1 : Math.max(0, item.qtd ?? 1)), 0);
  return { count, lines };
}
