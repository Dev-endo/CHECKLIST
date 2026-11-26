/**
 * Dia Laboratório: regras puras (sem React nem banco). O banco (migration 108) guarda uma linha por passagem do ativo
 * pelo laboratório (onde ele está agora) e os balões (com quem está, e o que cada técnico finalizou ou transferiu).
 */

/** Onde o ativo está. */
export type LabStatus =
  | "aguardando_manutencao"
  | "transferencia_pendente"
  | "vidro"
  | "analise"
  | "quarentena"
  | "reprovado_aguardando"
  | "quarentena_aprovada"
  | "pt"
  | "revenda"
  | "bloqueado";

export const LAB_STATUS_LABELS: Record<LabStatus, string> = {
  aguardando_manutencao: "Aguardando manutenção",
  transferencia_pendente: "Transferência pendente",
  vidro: "Vidro",
  analise: "Aguardando análise técnica",
  quarentena: "Em quarentena (aguardando resultado)",
  reprovado_aguardando: "Reprovado na quarentena (aguardando redistribuição)",
  quarentena_aprovada: "Quarentena aprovada",
  pt: "PT",
  revenda: "Revenda",
  bloqueado: "Bloqueado",
};

/** Saíram do laboratório e contam na meta de saída. */
export const EXIT_COUNTED: readonly LabStatus[] = ["quarentena_aprovada", "pt"];
/** Saíram do laboratório, mas não contam na meta de saída. */
export const EXIT_NOT_COUNTED: readonly LabStatus[] = ["revenda", "bloqueado"];

export const isInLab = (status: LabStatus) => !EXIT_COUNTED.includes(status) && !EXIT_NOT_COUNTED.includes(status);

/** Destino escolhido no fim do checklist (ou a transferência). */
export type BalloonOutcome = "quarentena" | "vidro" | "analise" | "pt" | "revenda" | "bloqueado" | "transferido";

export const OUTCOME_LABELS: Record<BalloonOutcome, string> = {
  quarentena: "Quarentena",
  vidro: "Vidro",
  analise: "Avaliação técnica",
  pt: "PT",
  revenda: "Revenda",
  bloqueado: "Bloqueado",
  transferido: "Transferido",
};

export type BalloonSource = "entrega" | "vidro" | "redistribuicao" | "transferencia" | "retorno";

export const SOURCE_LABELS: Record<BalloonSource, string> = {
  entrega: "Entregue pelo supervisor",
  vidro: "Direcionado do Vidro",
  redistribuicao: "Reprovado na quarentena (redistribuído)",
  transferencia: "Transferido",
  retorno: "Voltou para você",
};

// Bipar / colar seriais --------------------------------------------------------------------------------------------

/** Seriais da caixa: um por bipagem (Enter) ou colados separados por quebra de linha, vírgula, ponto e vírgula ou espaço. */
export function parseSerials(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export const serialKey = (serial: string) => serial.trim().toLowerCase();

export interface SerialCheck {
  serial: string;
  found: boolean;
  unit: string | null;
  model: string | null;
  /** Onde o ativo está (passagem aberta), se estiver no laboratório. */
  labStatus: LabStatus | null;
  /** Com quem está o balão aberto (ou a transferência pendente). */
  holder: string | null;
}

export type SerialProblem = "duplicado" | "nao_encontrado" | "com_tecnico" | "fora_do_vidro" | null;

export const PROBLEM_LABELS: Record<Exclude<SerialProblem, null>, string> = {
  duplicado: "Serial repetido na lista",
  nao_encontrado: "Serial não encontrado",
  com_tecnico: "Já vinculado a outro técnico",
  fora_do_vidro: "Não está no Vidro",
};

export interface PreviewRow extends SerialCheck {
  problem: SerialProblem;
}

/**
 * Lista prévia: cada serial com o resultado da busca e o aviso. A primeira ocorrência de um serial repetido vale; as
 * demais ficam marcadas como duplicadas. `onlyGlass`: o direcionamento do Vidro só aceita ativos com status Vidro.
 */
export function previewRows(serials: readonly string[], checks: ReadonlyMap<string, SerialCheck>, onlyGlass = false): PreviewRow[] {
  const seen = new Set<string>();
  return serials.map((serial) => {
    const key = serialKey(serial);
    const check = checks.get(key) ?? { serial, found: false, unit: null, model: null, labStatus: null, holder: null };
    let problem: SerialProblem = null;
    if (seen.has(key)) problem = "duplicado";
    else if (!check.found) problem = "nao_encontrado";
    else if (check.holder) problem = "com_tecnico";
    else if (onlyGlass && check.labStatus !== "vidro") problem = "fora_do_vidro";
    seen.add(key);
    return { ...check, serial, problem };
  });
}

/** Seriais que podem ser vinculados (sem aviso), sem repetir. */
export const validSerials = (rows: readonly PreviewRow[]) => rows.filter((row) => !row.problem).map((row) => row.serial);

// Acompanhamento ---------------------------------------------------------------------------------------------------

/** Uma passagem do ativo pelo laboratório. */
export interface BoardAsset {
  id: string;
  serial: string;
  unit: string | null;
  status: LabStatus;
  technician: string | null;
  lastTechnician: string | null;
  enteredAt: string;
  exitedAt: string | null;
  rejectedAt: string | null;
  lastMoveAt: string;
  /** OS da passagem (o mesmo serial só conta de novo com outra OS). */
  osNumber: string | null;
}

export type BalloonStatus = "pendente" | "aberto" | "finalizado" | "transferido";

export interface BalloonRow {
  id: string;
  serial: string;
  unit: string | null;
  technicianId: string;
  technician: string;
  status: BalloonStatus;
  source: BalloonSource;
  fromName: string | null;
  transferredTo: string | null;
  outcome: BalloonOutcome | null;
  createdAt: string;
  confirmedAt: string | null;
  finishedAt: string | null;
  osNumber: string | null;
}

/** Uma linha das listas abertas ao clicar num contador. */
export interface ListRow {
  serial: string;
  unit: string | null;
  os: string | null;
  technician: string | null;
  status: string;
  at: string;
}

export type GroupId =
  | "entraram"
  | "sairam"
  | "destino_pt"
  | "destino_revenda"
  | "destino_vidro"
  | "destino_quarentena"
  | "destino_bloqueado"
  | "destino_analise"
  | "quarentena_aguardando"
  | "quarentena_aprovada"
  | "quarentena_reprovada"
  | "lab_total"
  | "lab_vidro"
  | "lab_aguardando"
  | "lab_analise"
  | "lab_quarentena"
  | "lab_reprovados"
  | "lab_pendentes";

export const GROUP_LABELS: Record<GroupId, string> = {
  entraram: "Entraram",
  sairam: "Saíram (meta de saída)",
  destino_pt: "PT",
  destino_revenda: "Revenda",
  destino_vidro: "Vidro",
  destino_quarentena: "Quarentena (aguardando)",
  destino_bloqueado: "Bloqueado",
  destino_analise: "Avaliação técnica",
  quarentena_aguardando: "Quarentena aguardando",
  quarentena_aprovada: "Quarentena aprovada",
  quarentena_reprovada: "Quarentena reprovada",
  lab_total: "Ainda no laboratório",
  lab_vidro: "Em Vidro",
  lab_aguardando: "Aguardando manutenção (balões)",
  lab_analise: "Aguardando análise técnica",
  lab_quarentena: "Em quarentena aguardando resultado",
  lab_reprovados: "Reprovados aguardando redistribuição",
  lab_pendentes: "Transferências pendentes",
};

const inRange = (iso: string | null, from: Date, to: Date) => {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  return time >= from.getTime() && time < to.getTime();
};

const assetRow = (asset: BoardAsset, at = asset.lastMoveAt): ListRow => ({
  serial: asset.serial,
  unit: asset.unit,
  os: asset.osNumber,
  technician: asset.technician ?? asset.lastTechnician,
  status: LAB_STATUS_LABELS[asset.status],
  at,
});

const balloonRow = (balloon: BalloonRow): ListRow => ({
  serial: balloon.serial,
  unit: balloon.unit,
  os: balloon.osNumber,
  technician: balloon.technician,
  status: balloonStatusLabel(balloon),
  at: balloon.finishedAt ?? balloon.confirmedAt ?? balloon.createdAt,
});

export function balloonStatusLabel(balloon: Pick<BalloonRow, "status" | "outcome">): string {
  if (balloon.status === "pendente") return "Transferência pendente";
  if (balloon.status === "aberto") return "Aguardando manutenção";
  if (balloon.status === "transferido") return "Transferido";
  return balloon.outcome ? OUTCOME_LABELS[balloon.outcome] : "Finalizado";
}

const DESTINATION_GROUPS: [GroupId, BalloonOutcome][] = [
  ["destino_pt", "pt"],
  ["destino_revenda", "revenda"],
  ["destino_vidro", "vidro"],
  ["destino_quarentena", "quarentena"],
  ["destino_bloqueado", "bloqueado"],
  ["destino_analise", "analise"],
];

const IN_LAB_GROUPS: [GroupId, LabStatus][] = [
  ["lab_vidro", "vidro"],
  ["lab_aguardando", "aguardando_manutencao"],
  ["lab_analise", "analise"],
  ["lab_quarentena", "quarentena"],
  ["lab_reprovados", "reprovado_aguardando"],
  ["lab_pendentes", "transferencia_pendente"],
];

/** O último balão finalizado de cada serial e OS (sem OS só vale se o serial não aparecer com OS). */
export function latestPerAsset(balloons: readonly BalloonRow[]): BalloonRow[] {
  const latest = new Map<string, BalloonRow>();
  const time = (b: BalloonRow) => new Date(b.finishedAt ?? b.createdAt).getTime();
  for (const balloon of balloons) {
    const key = `${serialKey(balloon.serial)}|${(balloon.osNumber ?? "").trim().toLowerCase()}`;
    const current = latest.get(key);
    if (!current || time(balloon) > time(current)) latest.set(key, balloon);
  }
  const withOs = new Set([...latest.values()].filter((b) => b.osNumber).map((b) => serialKey(b.serial)));
  return [...latest.values()].filter((b) => b.osNumber || !withOs.has(serialKey(b.serial)));
}

/** Um por serial (qualquer OS): fica a linha mais recente. */
export function uniqueBySerial(rows: readonly ListRow[]): ListRow[] {
  const latest = new Map<string, ListRow>();
  for (const row of rows) {
    const key = serialKey(row.serial);
    const current = latest.get(key);
    if (!current || new Date(row.at).getTime() > new Date(current.at).getTime()) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/**
 * O mesmo serial conta uma vez por OS (fica a movimentação mais recente). Sem OS, só conta se o serial não aparecer
 * com nenhuma OS no grupo.
 */
export function uniqueBySerialOs(rows: readonly ListRow[]): ListRow[] {
  const latest = new Map<string, ListRow>();
  for (const row of rows) {
    const key = `${serialKey(row.serial)}|${(row.os ?? "").trim().toLowerCase()}`;
    const current = latest.get(key);
    if (!current || new Date(row.at).getTime() > new Date(current.at).getTime()) latest.set(key, row);
  }
  const withOs = new Set([...latest.values()].filter((row) => row.os).map((row) => serialKey(row.serial)));
  return [...latest.values()]
    .filter((row) => row.os || !withOs.has(serialKey(row.serial)))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/**
 * Painel geral: cada contador com a lista dos ativos dele (o mesmo serial só conta de novo com outra OS). Entraram, saíram, destinos e quarentena aprovada ou
 * reprovada são do período; "ainda no laboratório" é o retrato de agora.
 */
export function labOverview(
  board: readonly BoardAsset[],
  balloons: readonly BalloonRow[],
  from: Date,
  to: Date,
  /** Lista Aguardando da aba Quarentena (conferência física): quando vem, é o que o card Quarentena mostra. */
  quarantineWaiting?: readonly ListRow[] | null,
): Record<GroupId, ListRow[]> {
  const groups = {} as Record<GroupId, ListRow[]>;
  groups.entraram = board.filter((a) => inRange(a.enteredAt, from, to)).map((a) => assetRow(a, a.enteredAt));
  groups.sairam = board
    .filter((a) => EXIT_COUNTED.includes(a.status) && inRange(a.exitedAt, from, to))
    .map((a) => assetRow(a, a.exitedAt ?? a.lastMoveAt));

  // Destinos: o mesmo serial (com a mesma OS) conta uma vez só, no último destino do período.
  const finished = latestPerAsset(balloons.filter((b) => b.status === "finalizado" && inRange(b.finishedAt, from, to)));
  for (const [group, outcome] of DESTINATION_GROUPS) {
    groups[group] = finished.filter((b) => b.outcome === outcome).map(balloonRow);
  }

  groups.quarentena_aguardando = board.filter((a) => a.status === "quarentena" && !a.exitedAt).map((a) => assetRow(a));
  groups.quarentena_aprovada = board
    .filter((a) => a.status === "quarentena_aprovada" && inRange(a.exitedAt, from, to))
    .map((a) => assetRow(a, a.exitedAt ?? a.lastMoveAt));
  groups.quarentena_reprovada = board
    .filter((a) => inRange(a.rejectedAt, from, to))
    .map((a) => ({ ...assetRow(a, a.rejectedAt ?? a.lastMoveAt), status: `Reprovado · agora: ${LAB_STATUS_LABELS[a.status]}` }));

  const inLab = board.filter((a) => !a.exitedAt && isInLab(a.status));
  groups.lab_total = inLab.map((a) => assetRow(a));
  for (const [group, status] of IN_LAB_GROUPS) {
    groups[group] = inLab.filter((a) => a.status === status).map((a) => assetRow(a));
  }
  for (const id of Object.keys(groups) as GroupId[]) groups[id] = uniqueBySerialOs(groups[id]);
  if (quarantineWaiting) {
    // Quarentena aguardando (Por destino e Ainda no laboratório): a lista Aguardando da aba Quarentena, um por serial,
    // que bate com a conferência física. Antes, "Ainda no laboratório" contava só quem tinha status quarentena no
    // laboratório e deixava de fora os incluídos na conferência e quem chegou à quarentena sem passar pelo balão.
    const waiting = uniqueBySerial([...quarantineWaiting]);
    groups.destino_quarentena = waiting;
    groups.quarentena_aguardando = waiting;
    groups.lab_quarentena = waiting;
    // Cada serial conta num card só: quem está na lista Aguardando (conferência física) sai dos outros cards de
    // "Ainda no laboratório", e o total é a soma dos cards.
    const inQuarantine = new Set(waiting.map((row) => serialKey(row.serial)));
    const notWaiting = (row: ListRow) => !inQuarantine.has(serialKey(row.serial));
    for (const [group, status] of IN_LAB_GROUPS) {
      if (status !== "quarentena") groups[group] = groups[group].filter(notWaiting);
    }
    const others = uniqueBySerialOs(inLab.filter((a) => a.status !== "quarentena").map((a) => assetRow(a))).filter(notWaiting);
    groups.lab_total = [...others, ...waiting].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }
  // Entraram: cada serial conta uma vez no período, mesmo com outra OS (fica a entrada mais recente).
  groups.entraram = uniqueBySerial(groups.entraram);
  return groups;
}

// Operação no período (migration 125) --------------------------------------------------------------------------------

/** Um evento do período: entrada (supervisor, Vidro ou retorno), saída (PT/Bloqueado/Revenda) ou envio à quarentena. */
export interface FlowEvent {
  kind: "entrega" | "vidro" | "retorno" | "saida" | "quarentena";
  serial: string;
  os: string | null;
  unit: string | null;
  technician: string | null;
  at: string;
  /** Onde o ativo está agora. */
  currentStatus: LabStatus | null;
  /** Saída: o destino. Quarentena: o primeiro resultado depois do envio (aprovado ou reprovado). */
  result: string | null;
  resultAt: string | null;
}

export type FlowGroupId =
  | "entraram"
  | "vidro_montagem"
  | "retornaram"
  | "saida_pt"
  | "saida_bloqueado"
  | "saida_revenda"
  | "saidas_total"
  | "quarentena_ontem"
  | "quarentena_liberado"
  | "quarentena_recusado"
  | "quarentena_ainda";

export const FLOW_LABELS: Record<FlowGroupId, string> = {
  entraram: "Entraram",
  vidro_montagem: "Saíram do vidro para montagem",
  retornaram: "Retornaram",
  saida_pt: "PT",
  saida_bloqueado: "Bloqueado",
  saida_revenda: "Revenda",
  saidas_total: "Total de saídas",
  quarentena_ontem: "Foram para quarentena ontem",
  quarentena_liberado: "Quarentena liberado",
  quarentena_recusado: "Quarentena recusado",
  quarentena_ainda: "Ainda em quarentena",
};

const ENTRY_LABELS: Record<"entrega" | "vidro" | "retorno", string> = {
  entrega: "Entregue pelo supervisor",
  vidro: "Direcionado do Vidro",
  retorno: "Retornou para o técnico",
};

const shiftDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const startOfLocalDay = (iso: string) => {
  const date = new Date(iso);
  date.setHours(0, 0, 0, 0);
  return date;
};

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

const flowRow = (event: FlowEvent, status: string): ListRow => ({
  serial: event.serial,
  unit: event.unit,
  os: event.os,
  technician: event.technician,
  status,
  at: event.at,
});

/**
 * Operação no período. Entradas e saídas são do período (o mesmo serial com a mesma OS conta uma vez por card).
 * Quarentena, dia a dia: para cada dia D do período, os enviados em D-1; "liberado" = aprovado até o fim de D;
 * "recusado" = reprovado até o fim de D (é redistribuído e volta em "Retornaram"); "ainda" = os enviados que não foram
 * aprovados nem reprovados até o fim de D. A busca de serial vale para todos os cards.
 */
export function flowOverview(events: readonly FlowEvent[], from: Date, to: Date, query = ""): Record<FlowGroupId, ListRow[]> {
  const visible = events.filter((event) => matchesSerial(event.serial, query));
  const inPeriod = visible.filter((event) => inRange(event.at, from, to));
  const groups = {} as Record<FlowGroupId, ListRow[]>;

  const entries = (kind: "entrega" | "vidro" | "retorno") =>
    uniqueBySerialOs(inPeriod.filter((event) => event.kind === kind).map((event) => flowRow(event, ENTRY_LABELS[kind])));
  groups.entraram = entries("entrega");
  groups.vidro_montagem = entries("vidro");
  groups.retornaram = entries("retorno");

  const exits = (destination: "pt" | "bloqueado" | "revenda") =>
    uniqueBySerialOs(
      inPeriod
        .filter((event) => event.kind === "saida" && event.result === destination)
        .map((event) => flowRow(event, OUTCOME_LABELS[destination])),
    );
  groups.saida_pt = exits("pt");
  groups.saida_bloqueado = exits("bloqueado");
  groups.saida_revenda = exits("revenda");

  // Quarentena: enviados em D-1 para cada D do período; um por serial e dia de envio (fica o envio mais recente).
  const sends = new Map<string, FlowEvent>();
  for (const event of visible) {
    if (event.kind !== "quarentena" || !inRange(event.at, shiftDays(from, -1), shiftDays(to, -1))) continue;
    const key = `${serialKey(event.serial)}|${startOfLocalDay(event.at).getTime()}`;
    const current = sends.get(key);
    if (!current || new Date(event.at).getTime() > new Date(current.at).getTime()) sends.set(key, event);
  }
  const sent = [...sends.values()].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const decided = (event: FlowEvent, result: "aprovado" | "reprovado") =>
    event.result === result && !!event.resultAt && new Date(event.resultAt).getTime() < shiftDays(startOfLocalDay(event.at), 2).getTime();
  const sentLabel = (event: FlowEvent) => `Enviado em ${shortDate(event.at)}`;
  groups.quarentena_ontem = sent.map((event) => flowRow(event, sentLabel(event)));
  groups.quarentena_liberado = sent
    .filter((event) => decided(event, "aprovado"))
    .map((event) => ({ ...flowRow(event, `${sentLabel(event)} · liberado em ${shortDate(event.resultAt!)}`), at: event.resultAt! }));
  groups.quarentena_recusado = sent
    .filter((event) => decided(event, "reprovado"))
    .map((event) => ({ ...flowRow(event, `${sentLabel(event)} · recusado em ${shortDate(event.resultAt!)}`), at: event.resultAt! }));
  groups.quarentena_ainda = sent
    .filter((event) => !decided(event, "aprovado") && !decided(event, "reprovado"))
    .map((event) => flowRow(event, sentLabel(event)));

  groups.saidas_total = [...groups.saida_pt, ...groups.saida_bloqueado, ...groups.saida_revenda, ...groups.quarentena_liberado].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );

  return groups;
}

/** Linha da lista do técnico: Técnico | Serial | Unit ID | Status/Destino | Transferido para | Recebido de. */
export interface TechnicianRow {
  technician: string;
  serial: string;
  unit: string | null;
  status: string;
  transferredTo: string | null;
  receivedFrom: string | null;
  at: string;
  /** Ainda com ele (aberto ou transferência pendente): o supervisor pode retirar. */
  removable: boolean;
}

export interface TechnicianSummary {
  technicianId: string;
  name: string;
  /** Balões abertos com ele (na bancada). */
  bench: number;
  /** Transferências para ele aguardando a confirmação. */
  pending: number;
  /** Na mesa: bancada + aguardando confirmação. */
  desk: number;
  /** Finalizados no período (transferidos contam). */
  finished: number;
  /** Transferidos por ele no período. */
  transferred: number;
  rows: TechnicianRow[];
}

/** Lista por técnico, com a bancada de agora e o que ele fez no período. */
export function technicianSummaries(balloons: readonly BalloonRow[], from: Date, to: Date): TechnicianSummary[] {
  const byTech = new Map<string, TechnicianSummary>();
  // Finalizados e transferidos contam um por serial e OS (o mesmo ativo trabalhado de novo não conta outra vez).
  const finishedKeys = new Map<string, Set<string>>();
  const transferredKeys = new Map<string, Set<string>>();
  const keyOf = (balloon: BalloonRow) => `${serialKey(balloon.serial)}|${(balloon.osNumber ?? "").trim().toLowerCase()}`;
  const add = (map: Map<string, Set<string>>, tech: string, key: string) => map.set(tech, (map.get(tech) ?? new Set()).add(key));
  for (const balloon of balloons) {
    const summary =
      byTech.get(balloon.technicianId) ??
      ({ technicianId: balloon.technicianId, name: balloon.technician, bench: 0, pending: 0, desk: 0, finished: 0, transferred: 0, rows: [] } as TechnicianSummary);
    byTech.set(balloon.technicianId, summary);
    if (balloon.status === "aberto") summary.bench += 1;
    if (balloon.status === "pendente") summary.pending += 1;
    const doneInRange = (balloon.status === "finalizado" || balloon.status === "transferido") && inRange(balloon.finishedAt, from, to);
    if (doneInRange) add(finishedKeys, balloon.technicianId, keyOf(balloon));
    if (doneInRange && balloon.status === "transferido") add(transferredKeys, balloon.technicianId, keyOf(balloon));
    summary.rows.push({
      technician: balloon.technician,
      serial: balloon.serial,
      unit: balloon.unit,
      status: balloonStatusLabel(balloon),
      transferredTo: balloon.status === "transferido" ? balloon.transferredTo : null,
      receivedFrom: balloon.source === "transferencia" ? balloon.fromName : null,
      at: balloon.finishedAt ?? balloon.confirmedAt ?? balloon.createdAt,
      removable: balloon.status === "aberto" || balloon.status === "pendente",
    });
  }
  return [...byTech.values()]
    .map((summary) => ({
      ...summary,
      desk: summary.bench + summary.pending,
      finished: finishedKeys.get(summary.technicianId)?.size ?? 0,
      transferred: transferredKeys.get(summary.technicianId)?.size ?? 0,
    }))
    .sort((a, b) => b.desk - a.desk || a.name.localeCompare(b.name, "pt-BR"));
}

/** "3 ativos na bancada + 1 aguardando confirmação de transferência = 4 na mesa". */
export function deskLabel(summary: Pick<TechnicianSummary, "bench" | "pending" | "desk">): string {
  const bench = `${summary.bench} ${summary.bench === 1 ? "ativo" : "ativos"} na bancada`;
  if (!summary.pending) return bench;
  return `${bench} + ${summary.pending} aguardando confirmação de transferência = ${summary.desk} na mesa`;
}

/** Filtra pela busca de serial (parte do serial, sem diferença de maiúsculas). */
export const matchesSerial = (serial: string, query: string) => !query.trim() || serial.toLowerCase().includes(query.trim().toLowerCase());

/** CSV para o Excel (separador ponto e vírgula, com BOM). */
export function toCsv(header: readonly string[], rows: readonly (readonly (string | null | undefined)[])[]): string {
  const cell = (value: string | null | undefined) => {
    const text = value ?? "";
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return "﻿" + [header, ...rows].map((row) => row.map(cell).join(";")).join("\r\n");
}

// Meta do técnico ---------------------------------------------------------------------------------------------------

export interface LabGoal {
  /** Ativos finalizados hoje, um por serial e OS (transferidos contam). */
  finished: number;
  /** Desses, quantos foram transferidos. */
  transferred: number;
  /** Balões abertos com o técnico (pendentes não contam). */
  open: number;
  /** Transferências aguardando a confirmação dele. */
  pending: number;
  /** Meta = ativos (serial + OS) finalizados + abertos. */
  goal: number;
  /** Manutenções feitas informadas nos balões fechados hoje (o mesmo serial trabalhado de novo conta aqui). */
  maintenances: number;
  /** Balões fechados hoje, com repetição. */
  checklists: number;
  justification: string | null;
}

export const goalReached = (goal: Pick<LabGoal, "finished" | "goal">) => goal.goal > 0 && goal.finished >= goal.goal;
