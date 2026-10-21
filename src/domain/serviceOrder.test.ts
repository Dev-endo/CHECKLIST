import { describe, expect, it } from "vitest";
import {
  allStagesDone,
  analysisSenders,
  parseOsMap,
  quarantineSenders,
  rejections,
  stageProgress,
  type OsStep,
} from "./serviceOrder";

const step = (patch: Partial<OsStep>): OsStep => ({
  kind: "manutencao",
  phase: "concluido",
  status: "liberado",
  destination: null,
  person: "Ana",
  createdAt: "2026-10-20T10:00:00Z",
  concludedAt: "2026-10-20T11:00:00Z",
  failures: [],
  parts: [],
  note: null,
  consumptionNote: null,
  ptNote: null,
  ...patch,
});

describe("stageProgress", () => {
  it("marks each stage done, in progress or not done, with who did it", () => {
    const progress = stageProgress({
      steps: [
        step({ kind: "desmontagem", person: "Kaiky" }),
        step({ kind: "manutencao", person: "Lucas" }),
        step({ kind: "manutencao", person: "Lucas", phase: "pendente", concludedAt: null }),
        step({ kind: "montagem", phase: "pendente", concludedAt: null, person: "Gustavo" }),
      ],
      quarantine: [],
    });
    const by = Object.fromEntries(progress.map((stage) => [stage.id, stage]));
    expect(by.desmontagem).toMatchObject({ state: "feito", people: ["Kaiky"] });
    expect(by.desmontagem_tecnica?.state).toBe("nao_feito");
    expect(by.manutencao).toMatchObject({ state: "feito", people: ["Lucas"] });
    expect(by.montagem).toMatchObject({ state: "andamento", people: ["Gustavo"] });
    expect(by.quarentena?.state).toBe("nao_feito");
  });
});

describe("allStagesDone", () => {
  const done = (kinds: OsStep["kind"][], quarantined = true) =>
    allStagesDone(
      stageProgress({
        steps: kinds.map((kind) => step({ kind })),
        quarantine: quarantined ? [{ person: "Q", result: "aprovado", at: "2026-10-20T12:00:00Z" }] : [],
      }),
    );

  it("needs a disassembly (either kind), maintenance, assembly and quarantine", () => {
    expect(done(["desmontagem", "manutencao", "montagem"])).toBe(true);
    expect(done(["desmontagem_tecnica", "manutencao", "montagem"])).toBe(true);
    expect(done(["manutencao", "montagem"])).toBe(false);
    expect(done(["desmontagem", "manutencao", "montagem"], false)).toBe(false);
  });
});

describe("rejections", () => {
  it("lists the rejected stages with the reasons, in time order", () => {
    const list = rejections({
      steps: [
        step({
          kind: "montagem",
          status: "reprovado",
          person: "Gustavo",
          concludedAt: "2026-10-20T15:00:00Z",
          failures: ["Display"],
          parts: ["Tampa"],
          note: "Tela soltou",
        }),
        step({ kind: "manutencao", status: "liberado" }),
        step({ kind: "manutencao", status: "reprovado", phase: "pendente" }),
      ],
      quarantine: [{ person: "Q", result: "reprovado", at: "2026-10-20T16:00:00Z" }],
    });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ stage: "montagem", person: "Gustavo" });
    expect(list[0]?.reasons).toEqual(["Display", "Peças com erro: Tampa", "Observação: Tela soltou"]);
    expect(list[1]).toMatchObject({ stage: "quarentena", reasons: ["Reprovado na quarentena"] });
  });
});

describe("quarantineSenders", () => {
  it("returns who finished a checklist sending the device to quarantine", () => {
    expect(
      quarantineSenders({
        steps: [step({ kind: "montagem", destination: "quarentena", person: "Gustavo" }), step({ destination: "pt" })],
      }),
    ).toEqual(["Gustavo"]);
  });
});

describe("analysisSenders", () => {
  it("lists who sent the device to technical analysis and from which stage", () => {
    expect(
      analysisSenders({
        steps: [
          step({ kind: "desmontagem_tecnica", destination: "analise", person: "Sabrina" }),
          step({ kind: "desmontagem_tecnica", destination: "analise", person: "Sabrina" }),
          step({ kind: "manutencao", destination: "analise", phase: "pendente" }),
          step({ kind: "manutencao", destination: "montagem" }),
        ],
      }),
    ).toEqual([{ person: "Sabrina", stage: "desmontagem_tecnica" }]);
  });
});

describe("parseOsMap", () => {
  it("reads the rpc payload and ignores malformed parts", () => {
    const map = parseOsMap({
      id: "1",
      os_number: "123",
      serial: "ABC",
      created_at: "2026-10-20T10:00:00Z",
      ordinal: 2,
      total: 3,
      steps: [{ kind: "montagem", phase: "concluido", status: "reprovado", parts: [{ item: "Tampa" }], failures: ["x"] }, { kind: "x" }],
      quarantine: [{ person: "Q", result: "aprovado", at: "2026-10-20T12:00:00Z" }, {}],
    });
    expect(map).toMatchObject({ osNumber: "123", ordinal: 2, total: 3 });
    expect(map?.steps).toHaveLength(1);
    expect(map?.steps[0]?.parts).toEqual(["Tampa"]);
    expect(map?.quarantine).toHaveLength(1);
    expect(parseOsMap(null)).toBeNull();
  });
});
