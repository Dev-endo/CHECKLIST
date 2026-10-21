import type { ChecklistKind } from "./checklist";
import { describeMaintenance, parseMaintenances } from "./maintenance";

/** Um checklist do aparelho dentro de uma OS. */
export interface OsStep {
  kind: ChecklistKind;
  phase: "pendente" | "concluido";
  status: string;
  destination: string | null;
  person: string;
  createdAt: string;
  concludedAt: string | null;
  failures: string[];
  /** Peças com erro marcadas na montagem reprovada. */
  parts: string[];
  note: string | null;
  consumptionNote: string | null;
  ptNote: string | null;
}

/** Um registro da aba Quarentena dentro de uma OS. */
export interface OsQuarantine {
  person: string;
  result: string;
  at: string;
}

/** Os dados de uma OS e tudo o que foi feito no aparelho dentro dela. */
export interface OsMap {
  id: string;
  osNumber: string;
  serial: string;
  unit: string | null;
  model: string | null;
  createdAt: string;
  registeredBy: string | null;
  /** Esta é a `ordinal`-ésima OS do ativo, de `total`. */
  ordinal: number;
  total: number;
  steps: OsStep[];
  quarantine: OsQuarantine[];
}

export type StageState = "feito" | "andamento" | "nao_feito";

export interface StageProgress {
  id: "desmontagem" | "desmontagem_tecnica" | "manutencao" | "montagem" | "quarentena";
  label: string;
  state: StageState;
  /** Quem fez (sem repetir). */
  people: string[];
}

const STEP_STAGES: { id: Exclude<StageProgress["id"], "quarentena">; label: string }[] = [
  { id: "desmontagem", label: "Desmontagem" },
  { id: "desmontagem_tecnica", label: "Desmontagem técnica" },
  { id: "manutencao", label: "Manutenção" },
  { id: "montagem", label: "Montagem" },
];

const unique = (values: string[]) => [...new Set(values)];

/** Situação de cada etapa da OS: concluída, em andamento (pendente) ou não feita. */
export function stageProgress(map: Pick<OsMap, "steps" | "quarantine">): StageProgress[] {
  const stages: StageProgress[] = STEP_STAGES.map(({ id, label }) => {
    const own = map.steps.filter((step) => step.kind === id);
    const done = own.filter((step) => step.phase === "concluido");
    const state: StageState = done.length ? "feito" : own.length ? "andamento" : "nao_feito";
    return { id, label, state, people: unique((done.length ? done : own).map((step) => step.person)) };
  });
  stages.push({
    id: "quarentena",
    label: "Quarentena",
    state: map.quarantine.length ? "feito" : "nao_feito",
    people: unique(map.quarantine.map((entry) => entry.person)),
  });
  return stages;
}

/**
 * Todos os checklists foram feitos: uma desmontagem (normal ou técnica), a manutenção, a montagem
 * e a quarentena.
 */
export function allStagesDone(progress: readonly StageProgress[]): boolean {
  const done = (id: StageProgress["id"]) => progress.find((stage) => stage.id === id)?.state === "feito";
  return (done("desmontagem") || done("desmontagem_tecnica")) && done("manutencao") && done("montagem") && done("quarentena");
}

/** Etapas concluídas com reprovação (checklist reprovado ou reprovado na quarentena), e o motivo de cada uma. */
export interface OsRejection {
  stage: ChecklistKind | "quarentena";
  person: string;
  at: string;
  reasons: string[];
}

export function rejections(map: Pick<OsMap, "steps" | "quarantine">): OsRejection[] {
  const fromSteps = map.steps
    .filter((step) => step.phase === "concluido" && step.status === "reprovado")
    .map<OsRejection>((step) => ({
      stage: step.kind,
      person: step.person,
      at: step.concludedAt ?? step.createdAt,
      reasons: [
        ...step.failures,
        ...(step.parts.length ? [`Peças com erro: ${step.parts.join(" · ")}`] : []),
        ...(step.note ? [`Observação: ${step.note}`] : []),
      ],
    }));
  const fromQuarantine = map.quarantine
    .filter((entry) => entry.result === "reprovado")
    .map<OsRejection>((entry) => ({
      stage: "quarentena",
      person: entry.person,
      at: entry.at,
      reasons: ["Reprovado na quarentena"],
    }));
  return [...fromSteps, ...fromQuarantine].sort((a, b) => a.at.localeCompare(b.at));
}

/** Quem enviou o aparelho para a quarentena (o destino do checklist foi quarentena). */
export function quarantineSenders(map: Pick<OsMap, "steps">): string[] {
  return unique(
    map.steps.filter((step) => step.phase === "concluido" && step.destination === "quarentena").map((step) => step.person),
  );
}

/** Quem enviou o aparelho para a análise técnica e de qual etapa (a análise não é um checklist). */
export function analysisSenders(map: Pick<OsMap, "steps">): { person: string; stage: ChecklistKind }[] {
  const seen = new Set<string>();
  const result: { person: string; stage: ChecklistKind }[] = [];
  for (const step of map.steps) {
    if (step.phase !== "concluido" || step.destination !== "analise") continue;
    const key = `${step.kind}|${step.person}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ person: step.person, stage: step.kind });
  }
  return result;
}

/** Lê o jsonb de `os_map`, ignorando o que não tiver o formato esperado. */
export function parseOsMap(raw: unknown): OsMap | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const id = text(row.id);
  const osNumber = text(row.os_number);
  const serial = text(row.serial);
  const createdAt = text(row.created_at);
  if (!id || !osNumber || !serial || !createdAt) return null;

  const steps = list(row.steps).flatMap<OsStep>((entry) => {
    const step = (entry ?? {}) as Record<string, unknown>;
    const kind = step.kind;
    if (kind !== "manutencao" && kind !== "montagem" && kind !== "desmontagem" && kind !== "desmontagem_tecnica") return [];
    return [
      {
        kind,
        phase: step.phase === "concluido" ? "concluido" : "pendente",
        status: text(step.status) ?? "incompleto",
        destination: text(step.destination),
        person: text(step.person) ?? "—",
        createdAt: text(step.created_at) ?? createdAt,
        concludedAt: text(step.concluded_at),
        failures: list(step.failures).filter((item): item is string => typeof item === "string"),
        parts: parseMaintenances(step.parts).map(describeMaintenance),
        note: text(step.notes),
        consumptionNote: text(step.consumption_note),
        ptNote: text(step.pt_note),
      },
    ];
  });
  const quarantine = list(row.quarantine).flatMap<OsQuarantine>((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const at = text(item.at);
    return at ? [{ person: text(item.person) ?? "—", result: text(item.result) ?? "", at }] : [];
  });
  return {
    id,
    osNumber,
    serial,
    unit: text(row.unit),
    model: text(row.model),
    createdAt,
    registeredBy: text(row.registered_by),
    ordinal: Number(row.ordinal) || 1,
    total: Number(row.total) || 1,
    steps,
    quarantine,
  };
}
