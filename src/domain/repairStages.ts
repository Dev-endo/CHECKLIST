/** Regras puras do Reparo (etapas, cronômetro e solicitações de peça); o banco é quem decide de verdade. */

export type TimerKind = "produtivo" | "pausa" | "espera_peca";

/** Totais em segundos que o banco devolve (repair_timer_totals). */
export interface TimerTotals {
  produtivo: number;
  pausa: number;
  espera_peca: number;
  openKind: TimerKind | null;
}

export const TIMER_LABELS: Record<TimerKind, string> = {
  produtivo: "Em andamento",
  pausa: "Pausado",
  espera_peca: "Aguardando peça",
};

/**
 * Totais agora: o que o banco contou mais o tempo corrido desde a leitura, só na sessão aberta.
 * `elapsedSinceFetch` vem do relógio do navegador (uma diferença, não uma hora), então relógio errado não distorce.
 */
export function liveTotals(base: TimerTotals, elapsedSinceFetch: number): TimerTotals {
  if (!base.openKind) return base;
  return { ...base, [base.openKind]: base[base.openKind] + Math.max(0, elapsedSinceFetch) };
}

/** 3725 -> "1:02:05". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s % 60)}`;
}

/** O botão do cronômetro: iniciar (nunca rodou), pausar (produtivo) ou retomar (pausa ou espera de peça). */
export function timerAction(totals: TimerTotals): { label: "Iniciar" | "Pausar" | "Retomar"; next: "produtivo" | "pausa" } {
  if (totals.openKind === "produtivo") return { label: "Pausar", next: "pausa" };
  const everRan = totals.produtivo + totals.pausa + totals.espera_peca > 0 || totals.openKind !== null;
  return { label: everRan ? "Retomar" : "Iniciar", next: "produtivo" };
}

export type RequestStatus = "pendente" | "em_separacao" | "sem_estoque" | "entregue" | "cancelada";
export type RequestPurpose = "teste" | "definitiva";

export const STATUS_LABELS: Record<RequestStatus, string> = {
  pendente: "Pendente",
  em_separacao: "Em separação",
  sem_estoque: "Sem estoque",
  entregue: "Entregue",
  cancelada: "Cancelada",
};

export const PURPOSE_LABELS: Record<RequestPurpose, string> = { teste: "Teste", definitiva: "Definitiva" };

/** Ainda não resolvida: o estoque não terminou (nem cancelou) a solicitação. */
export const isOpenRequest = (status: RequestStatus): boolean =>
  status === "pendente" || status === "em_separacao" || status === "sem_estoque";

/** Só dá para cancelar o que está aberto e sem nenhuma entrega. */
export const canCancelRequest = (status: RequestStatus, delivered: number): boolean => isOpenRequest(status) && delivered === 0;

/** Quantidade que ainda falta entregar. */
export const pendingBalance = (qty: number, delivered: number): number => Math.max(0, qty - delivered);

/** Mensagem para o erro que o banco devolve em cada função de pedido de peça. */
export function describeRepairError(error: { code?: string; message?: string } | null | undefined, fallback: string): string {
  const text = error?.message ?? "";
  if (error?.code === "23505") return "Já existe uma peça de teste desse tipo aberta ou sem destino nesta OS.";
  if (text.includes("no_os")) return "Registre a OS do aparelho antes.";
  if (error?.code === "42501" || text.includes("sem permissão")) return "Seu perfil não pode fazer isso.";
  if (text.includes("pedido já fechado")) return "Essa solicitação já foi fechada.";
  if (text.includes("stage_closed")) return "Essa etapa já foi concluída.";
  if (text.includes("tests_pending")) return "Ainda há testes obrigatórios sem resposta.";
  if (text.includes("request_pending")) return "Ainda há solicitações de peça em aberto.";
  if (text.includes("test_destiny_missing")) return "Defina o destino das peças de teste entregues.";
  if (text.includes("return_unconfirmed")) return "O estoque ainda não confirmou o recebimento de uma devolução.";
  if (text.includes("resale_reason_required")) return "Revenda exige uma justificativa.";
  if (text.includes("disassembly_open")) return "Conclua a desmontagem e a avaliação técnica antes.";
  return fallback;
}

/** Resumo do envio de várias peças de uma vez: o que foi enviado e o que o banco recusou (com o motivo). */
export function batchMessage(sent: number, failed: readonly { part: string; message: string }[]): string {
  const ok = sent === 1 ? "1 peça solicitada" : `${sent} peças solicitadas`;
  if (!failed.length) return ok;
  const why = failed.map((f) => `${f.part}: ${f.message}`).join(" · ");
  return sent ? `${ok}. Não enviadas: ${why}` : `Nenhuma peça enviada. ${why}`;
}

// Estoque ------------------------------------------------------------------------------------------------------

export type ReturnCondition = "funcional" | "com_defeito" | "necessita_avaliacao";
export type ReturnReason = "devolucao_teste" | "substituicao_defeito";
export type TestDestiny = "utilizacao_definitiva" | "devolucao";

export const CONDITION_LABELS: Record<ReturnCondition, string> = {
  funcional: "Funcional",
  com_defeito: "Com defeito",
  necessita_avaliacao: "Necessita avaliação",
};

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  devolucao_teste: "Devolução de peça de teste",
  substituicao_defeito: "Substituição por defeito",
};

export const DESTINY_LABELS: Record<TestDestiny, string> = {
  utilizacao_definitiva: "Utilização definitiva",
  devolucao: "Devolução solicitada",
};

export const MOVEMENT_LABELS: Record<string, string> = {
  solicitacao: "Solicitada",
  separacao: "Em separação",
  sem_estoque: "Marcada sem estoque",
  entrega: "Entrega confirmada",
  cancelamento: "Cancelada",
  destino_teste: "Destino da peça de teste",
  devolucao_solicitada: "Devolução solicitada",
  substituicao_solicitada: "Substituição solicitada",
  recebimento: "Recebimento confirmado",
  retorno_disponivel: "Voltou ao estoque disponível",
  segregacao: "Segregada (fora do disponível)",
};

/** Só peça recebida e classificada como funcional volta ao estoque disponível. */
export const returnsToStock = (condition: ReturnCondition): boolean => condition === "funcional";

/** O que o estoque ainda pode entregar de uma solicitação. */
export const deliverableQty = (qty: number, delivered: number): number => Math.max(0, qty - delivered);

/** Quantas unidades de uma peça definitiva ainda podem ser trocadas por defeito. */
export const replaceableQty = (delivered: number, alreadyReplaced: number): number => Math.max(0, delivered - alreadyReplaced);

export interface BoardRequest {
  id: string;
  osId: string;
  osNumber: string;
  serial: string;
  status: RequestStatus;
  createdAt: string;
}

export interface BoardGroup<T extends BoardRequest> {
  osId: string;
  osNumber: string;
  serial: string;
  requests: T[];
}

/**
 * Agrupa as solicitações por aparelho (serial) e OS. Dentro do grupo, da mais antiga para a mais nova;
 * os grupos com solicitação aberta mais antiga vêm primeiro, para o estoque atender na ordem de chegada.
 */
export function groupByDevice<T extends BoardRequest>(requests: readonly T[]): BoardGroup<T>[] {
  const groups = new Map<string, BoardGroup<T>>();
  for (const request of requests) {
    const group = groups.get(request.osId) ?? { osId: request.osId, osNumber: request.osNumber, serial: request.serial, requests: [] };
    group.requests.push(request);
    groups.set(request.osId, group);
  }
  const oldest = (group: BoardGroup<T>) =>
    Math.min(...group.requests.filter((r) => isOpenRequest(r.status)).map((r) => Date.parse(r.createdAt)), Number.POSITIVE_INFINITY);
  return [...groups.values()]
    .map((group) => ({ ...group, requests: [...group.requests].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) }))
    .sort((a, b) => oldest(a) - oldest(b) || a.serial.localeCompare(b.serial));
}

/** Texto do aviso ao estoquista para uma solicitação nova ou uma devolução aguardando recebimento. */
export function alertMessage(item: { kind: "solicitacao" | "devolucao"; requester: string; part: string; qty: number; purpose: RequestPurpose | null }): string {
  if (item.kind === "devolucao") return `${item.requester} devolveu ${item.part}: confirme o recebimento`;
  const amount = item.qty > 1 ? `${item.qty}× ` : "";
  return `${item.requester} solicitou ${amount}${item.part} para ${item.purpose === "teste" ? "teste" : "manutenção"}`;
}

// Fim do Estágio 1 ------------------------------------------------------------------------------------------------

/** Para onde o Estágio 1 manda o aparelho ao concluir a avaliação técnica. */
export type Stage1Destination = "manutencao" | "vidro" | "analise" | "aguardando_pecas";

export const STAGE1_DESTINATIONS: readonly { id: Stage1Destination; label: string; hint: string }[] = [
  { id: "manutencao", label: "Estágio 2 (manutenção)", hint: "O aparelho segue para a manutenção com os pedidos de peça da OS." },
  { id: "vidro", label: "Vidro", hint: "Só quando o aparelho precisa apenas de vidro. Pede Vidro e Aro ao estoque e abre o serviço na aba Vidro." },
  { id: "analise", label: "Análise técnica", hint: "O aparelho entra na fila da aba Análise técnica." },
  {
    id: "aguardando_pecas",
    label: "Aguardando peças",
    hint: "O Estágio 2 abre sozinho quando o estoque resolver todos os pedidos de peça em aberto da OS.",
  },
];

/** Aguardando peças só faz sentido com pedido aberto; os outros destinos estão sempre disponíveis. */
export const destinationAvailable = (destination: Stage1Destination, openRequests: number): boolean =>
  destination !== "aguardando_pecas" || openRequests > 0;

interface StageSummary {
  status: string;
  destination?: string | null;
  outcome?: string | null;
}

const OUTCOME_PLACES: Record<string, string> = {
  quarentena: "na quarentena",
  analise: "na fila de Análise",
  revenda: "em revenda",
  vidro: "no vidro",
};

/** Onde o ativo está agora, em uma frase, para quem bipa um aparelho que já passou pelo Estágio 1. */
export function deviceWhereabouts(stages: { evaluation: StageSummary | null; maintenance: StageSummary | null }): string | null {
  const { evaluation, maintenance } = stages;
  if (maintenance) {
    if (maintenance.status === "em_andamento") return "no Estágio 2 (manutenção)";
    if (maintenance.status === "aguardando_pecas") return "aguardando peças para o Estágio 2";
    return (maintenance.outcome && OUTCOME_PLACES[maintenance.outcome]) || "com a manutenção concluída";
  }
  if (evaluation?.destination === "vidro") return "no vidro";
  if (evaluation?.destination === "analise") return "na Análise técnica";
  return null;
}
