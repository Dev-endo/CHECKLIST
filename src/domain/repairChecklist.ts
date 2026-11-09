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
// Display, proximidade, câmeras e microfones são testados com o aparelho fechado E com ele aberto; o alto-falante
// e os botões também são testados fechados.
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

/**
 * Testes só com o aparelho fechado. O alto-falante e os botões também são testados abertos, dentro de "Auricular e
 * alto-falante" e "Botões e vibração". "Botões físicos" (e não "Botões") para o tópico não ter o mesmo id do item.
 */
const CLOSED_ONLY = [
  { title: "Alto-falante", items: itemsOf("audio-e-microfones", ["altofalante"]) },
  { title: "Botões físicos", items: itemsOf("botoes-e-vibracao", ["botoes"]) },
];

const CLOSED_CATALOG: readonly ChecklistBlock[] = buildCatalog([...SHARED, ...CLOSED_ONLY]);
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

/**
 * Destino escolhido ao finalizar: automático (quarentena ou análise pelos testes), Análise técnica (mesmo sem teste
 * reprovado), vidro (sem exigir o checklist), revenda (com motivo) ou PT, perda total (com motivo; espera a
 * aprovação de um administrador ou supervisor).
 */
export type FinishDestination = "auto" | "vidro" | "revenda" | "analise" | "pt" | "bloqueado" | "manutencao";

/** Destinos que não exigem o checklist: o aparelho vai para o vidro (e volta) ou espera a aprovação do PT. */
export const skipsChecklist = (destination: FinishDestination) =>
  destination === "vidro" || destination === "pt" || destination === "bloqueado" || destination === "manutencao";

/**
 * Fases do checklist que não precisam ser feitas para o destino. Na Análise técnica não precisa dos testes com o
 * aparelho fechado (o aberto continua obrigatório); vidro, PT e bloqueado dispensam as duas.
 */
export const skippedPhases = (destination: FinishDestination): readonly ChecklistPhase[] =>
  skipsChecklist(destination) ? PHASES : destination === "analise" ? ["fechado"] : [];

/** Destinos que exigem um motivo escrito (o mesmo campo). */
export const needsReason = (destination: FinishDestination) =>
  destination === "revenda" || destination === "pt" || destination === "bloqueado" || destination === "manutencao";

/** Opções de destino ao finalizar (Reparo, Estágio 2, e Checklist manutenção). */
export const FINISH_DESTINATIONS: readonly { id: FinishDestination; label: string; hint: string }[] = [
  { id: "auto", label: "Quarentena", hint: "Tudo aprovado. Com algum teste reprovado, o aparelho vai para a Análise técnica." },
  { id: "analise", label: "Análise técnica", hint: "Entra na fila da Análise técnica, mesmo sem teste reprovado. Não precisa dos testes com o aparelho fechado." },
  { id: "vidro", label: "Vidro", hint: "Não precisa do checklist: pede Vidro e Aro e abre o serviço na aba Vidro; depois o aparelho volta para você." },
  { id: "revenda", label: "Revenda", hint: "Exige o motivo." },
  { id: "pt", label: "PT (perda total)", hint: "Exige o motivo e não precisa do checklist. Fica pendente até um administrador ou supervisor aprovar." },
  { id: "bloqueado", label: "Bloqueado", hint: "Ativo travado (conta, MDM ou operadora). Exige o motivo e não precisa do checklist." },
];

/**
 * Aba Vidro: os mesmos destinos do Reparo mais "Manutenção", em que o técnico de vidro escolhe para qual técnico
 * de manutenção o aparelho vai (com o motivo).
 */
export const GLASS_FINISH_DESTINATIONS: readonly { id: FinishDestination; label: string; hint: string }[] = [
  ...FINISH_DESTINATIONS,
  { id: "manutencao", label: "Manutenção", hint: "Direciona o aparelho para um técnico de manutenção que você escolhe. Exige o motivo e não precisa do checklist." },
];

export interface FinishInput {
  results: Record<ChecklistPhase, Results>;
  /** `glass`: pedido do vidro (Vidro e Aro), que não trava a finalização. */
  requests: readonly { status: RequestStatus; purpose: RequestPurpose; testDestiny: TestDestiny | null; glass?: boolean }[];
  returnsWaiting: number;
  destination: FinishDestination;
  resaleReason: string;
  /** Fases que não precisam ser feitas (ex.: Checklist manutenção: fechado, quando o aberto teve falha). */
  skipPhases?: readonly ChecklistPhase[];
  /** Motivo do envio para a Análise técnica: obrigatório quando o aparelho vai para lá. */
  analysisNote?: string;
  /** Destino Manutenção: o técnico escolhido (obrigatório nesse destino). */
  technicianId?: string;
}

/** Tamanho mínimo da justificativa de envio para a Análise técnica (o banco confere o mesmo). */
export const ANALYSIS_NOTE_MIN = 5;

/**
 * O que ainda impede finalizar a manutenção, em português. A conferência de verdade é do banco; esta lista
 * só mostra ao técnico o que falta antes de ele clicar.
 */
export function finishBlockers(input: FinishInput): string[] {
  const blockers: string[] = [];
  for (const phase of PHASES) {
    if (skippedPhases(input.destination).includes(phase) || input.skipPhases?.includes(phase)) continue;
    const missing = pendingTests(phase, input.results[phase]).length;
    if (missing) blockers.push(`${PHASE_LABELS[phase]}: faltam ${missing} teste(s) obrigatório(s)`);
    const confirmations = missingPhaseConfirmations(phase, input.results[phase]);
    if (confirmations.length) blockers.push(`${PHASE_LABELS[phase]}: confirme ${confirmations.map((item) => item.title).join(", ")}`);
  }
  const open = input.requests.filter((r) => isOpenRequest(r.status) && !r.glass).length;
  if (open) blockers.push(`${open} solicitação(ões) de peça ainda em aberto: aguarde o estoque ou cancele`);
  const noDestiny = input.requests.filter((r) => r.purpose === "teste" && r.status === "entregue" && !r.testDestiny).length;
  if (noDestiny) blockers.push(`${noDestiny} peça(s) de teste entregue(s) sem destino: utilize ou devolva`);
  if (input.returnsWaiting) blockers.push(`${input.returnsWaiting} devolução(ões) aguardando o estoque confirmar o recebimento`);
  if (input.destination === "revenda" && input.resaleReason.trim().length < 5) blockers.push("Revenda exige o motivo");
  if (input.destination === "pt" && input.resaleReason.trim().length < 5) blockers.push("PT exige o motivo");
  if (input.destination === "bloqueado" && input.resaleReason.trim().length < 5) blockers.push("Bloqueado exige o motivo");
  if (input.destination === "manutencao" && !input.technicianId) blockers.push("Escolha o técnico de manutenção");
  if (input.destination === "manutencao" && input.resaleReason.trim().length < 5) blockers.push("Manutenção exige o motivo");
  if (expectedOutcome(input.results, input.destination) === "analise" && (input.analysisNote ?? "").trim().length < ANALYSIS_NOTE_MIN) {
    blockers.push("Escreva o motivo do envio para a Análise técnica");
  }
  return blockers;
}

/** Para onde o aparelho vai ao finalizar, pelo que está marcado (o banco confirma). */
export function expectedOutcome(
  results: Record<ChecklistPhase, Results>,
  destination: FinishDestination,
): "quarentena" | "analise" | "revenda" | "vidro" | "pt" | "bloqueado" | "manutencao" {
  if (destination === "manutencao") return "manutencao";
  if (destination === "bloqueado") return "bloqueado";
  if (destination === "pt") return "pt";
  if (destination === "revenda") return "revenda";
  if (destination === "vidro") return "vidro";
  if (destination === "analise") return "analise";
  const failed = PHASES.some((phase) => {
    const choice = new Set(choiceTests(phase));
    return requiredTests(phase).some((id) => results[phase][id] === "fail" && !choice.has(id));
  });
  return failed ? "analise" : "quarentena";
}

/** Algum teste obrigatório da fase reprovado (os de escolha não contam). */
export function phaseFailed(phase: ChecklistPhase, results: Results): boolean {
  const choice = new Set(choiceTests(phase));
  return requiredTests(phase).some((id) => results[id] === "fail" && !choice.has(id));
}

export const OUTCOME_LABELS = {
  quarentena: "Quarentena",
  vidro: "Vidro",
  analise: "Fila de Análise",
  revenda: "Revenda",
  pt: "PT (aprovação pendente)",
  bloqueado: "Bloqueado",
  manutencao: "Manutenção (outro técnico)",
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
  tipo: "placa" | "peca" | "limpeza";
  peca?: string;
  qtd?: number;
  descricao?: string | null;
}

/** Total de manutenções (placa = 1; cada peça = 1 por unidade) e as linhas para mostrar. */
export function summarizeMaintenance(items: readonly MaintenanceItem[]): { count: number; lines: string[] } {
  const lines = items.map((item) => {
    if (item.tipo === "limpeza") return "Limpeza";
    if (item.tipo === "placa") return item.descricao ? `Reparo em placa: ${item.descricao}` : "Reparo em placa";
    const qty = item.qtd ?? 1;
    return qty > 1 ? `${item.peca ?? "Peça"} (${qty})` : (item.peca ?? "Peça");
  });
  const count = items.reduce((total, item) => total + (item.tipo === "placa" || item.tipo === "limpeza" ? 1 : Math.max(0, item.qtd ?? 1)), 0);
  return { count, lines };
}
