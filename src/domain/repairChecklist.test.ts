import { describe, expect, it } from "vitest";
import {
  BATTERY_KEY,
  describeFailedTest,
  expectedOutcome,
  finishBlockers,
  fromSaved,
  parseFailedTests,
  summarizeMaintenance,
  pendingTests,
  phaseCatalog,
  requiredTests,
  toggleBlockResult,
  toSaved,
  type FinishInput,
} from "./repairChecklist";

const allOk = (phase: "aberto" | "fechado") => Object.fromEntries(requiredTests(phase).map((id) => [id, "ok" as const]));

const ready = (over: Partial<FinishInput> = {}): FinishInput => ({
  results: { aberto: { ...allOk("aberto"), "confirm:imei": "ok" }, fechado: allOk("fechado") },
  requests: [],
  returnsWaiting: 0,
  destination: "auto",
  resaleReason: "",
  ...over,
});

const SHARED = ["tela-e-touch", "sensor-de-proximidade", "cameras", "microfones"];

describe("repair checklist", () => {
  it("tests display, proximity, cameras and microphones with the device closed", () => {
    expect(requiredTests("fechado")).toEqual(SHARED);
  });

  it("tests those four and every other test with the device open", () => {
    const open = requiredTests("aberto");
    for (const id of SHARED) expect(open).toContain(id);
    for (const id of ["face-id-touch-id-e-nfc", "auricular-e-alto-falante", "conectividade-e-carga", "botoes-e-vibracao", "sistema"]) {
      expect(open).toContain(id);
      expect(requiredTests("fechado")).not.toContain(id);
    }
    expect(open).not.toContain("vidro-traseiro");
    expect(open).not.toContain("faltando-parafuso");
  });

  it("keeps every original test of the maintenance checklist in the right place", () => {
    const itemIds = (phase: "aberto" | "fechado") => phaseCatalog(phase).flatMap((block) => block.items.map((item) => item.id));
    const open = itemIds("aberto");
    for (const id of ["prox", "faceid", "nfc", "auricular", "altofalante", "mic-inf", "mic-tras", "mic-front", "foco", "wifi", "botoes", "bateria", "imei", "tela-branca"]) {
      expect(open.filter((x) => x === id)).toHaveLength(1);
    }
    expect(itemIds("fechado").sort()).toEqual(
      ["tela-branca", "tela-preta", "tela-ondulacao", "teclado", "truetone", "freeform", "prox", "foco", "lentes", "frontal", "flash", "mic-inf", "mic-tras", "mic-front"].sort(),
    );
  });

  it("round-trips what is saved, keeping the battery apart from the results", () => {
    const saved = toSaved({ a: "ok", b: "fail" }, 85);
    expect(saved[BATTERY_KEY]).toBe(85);
    expect(fromSaved(saved)).toEqual({ results: { a: "ok", b: "fail" }, battery: 85 });
    expect(fromSaved(toSaved({ a: "ok" }, undefined))).toEqual({ results: { a: "ok" }, battery: undefined });
    expect(fromSaved(null)).toEqual({ results: {}, battery: undefined });
    expect(fromSaved({ x: "talvez", y: 3 })).toEqual({ results: {}, battery: undefined });
  });

  it("counts the required tests still unanswered", () => {
    expect(pendingTests("fechado", {})).toHaveLength(4);
    expect(pendingTests("aberto", allOk("aberto"))).toEqual([]);
  });

  it("clears the pointed items when a topic leaves Failure", () => {
    const [block] = phaseCatalog("fechado");
    if (!block) throw new Error("catálogo vazio");
    const failed = toggleBlockResult({ [block.id]: "ok", "tela-branca": "fail" }, block, "fail");
    expect(failed["tela-branca"]).toBe("fail");
    const back = toggleBlockResult(failed, block, "ok");
    expect(back["tela-branca"]).toBeUndefined();
    expect(back[block.id]).toBe("ok");
  });
});

describe("finishBlockers", () => {
  it("is empty when everything is answered and resolved", () => {
    expect(finishBlockers(ready())).toEqual([]);
  });

  it("lists what blocks the finish", () => {
    const blockers = finishBlockers(
      ready({
        results: { aberto: allOk("aberto"), fechado: {} },
        requests: [
          { status: "pendente", purpose: "definitiva", testDestiny: null },
          { status: "entregue", purpose: "teste", testDestiny: null },
          { status: "entregue", purpose: "teste", testDestiny: "devolucao" },
        ],
        returnsWaiting: 2,
      }),
    );
    expect(blockers.join("|")).toMatch(/aparelho fechado: faltam 4/);
    expect(blockers.join("|")).toMatch(/aparelho aberto: confirme/);
    expect(blockers.join("|")).toMatch(/1 solicitação/);
    expect(blockers.join("|")).toMatch(/1 peça\(s\) de teste/);
    expect(blockers.join("|")).toMatch(/2 devolução/);
  });

  it("requires a reason for resale", () => {
    expect(finishBlockers(ready({ destination: "revenda", resaleReason: "x" }))).toEqual(["Revenda exige uma justificativa"]);
    expect(finishBlockers(ready({ destination: "revenda", resaleReason: "cliente pediu" }))).toEqual([]);
  });
});

describe("expectedOutcome", () => {
  it("goes to quarantine, analysis or resale", () => {
    expect(expectedOutcome(ready().results, "auto")).toBe("quarentena");
    expect(expectedOutcome({ aberto: allOk("aberto"), fechado: { ...allOk("fechado"), cameras: "fail" } }, "auto")).toBe("analise");
    expect(expectedOutcome({ aberto: { ...allOk("aberto"), sistema: "fail" }, fechado: allOk("fechado") }, "auto")).toBe("analise");
    expect(expectedOutcome(ready().results, "revenda")).toBe("revenda");
    expect(expectedOutcome(ready().results, "vidro")).toBe("vidro");
    expect(expectedOutcome(ready().results, "analise")).toBe("analise");
    expect(expectedOutcome({ aberto: allOk("aberto"), fechado: { ...allOk("fechado"), cameras: "fail" } }, "vidro")).toBe("vidro");
  });
});

describe("failed tests", () => {
  it("reads what the database stored and ignores the rest", () => {
    expect(parseFailedTests([{ fase: "fechado", teste: "cameras" }, { fase: "aberto", item: "faceid" }, { fase: "x", teste: "a" }, 3, null])).toEqual([
      { fase: "fechado", teste: "cameras" },
      { fase: "aberto", item: "faceid" },
    ]);
    expect(parseFailedTests("nada")).toEqual([]);
  });

  it("names the topic and the pointed item the way the technician saw them", () => {
    expect(describeFailedTest({ fase: "fechado", teste: "cameras" })).toBe("Aparelho fechado: Câmeras");
    expect(describeFailedTest({ fase: "fechado", item: "frontal" })).toBe("Aparelho fechado: Câmera frontal");
    expect(describeFailedTest({ fase: "aberto", teste: "sistema" })).toBe("Aparelho aberto: Sistema");
    expect(describeFailedTest({ fase: "aberto", teste: "desconhecido" })).toBe("Aparelho aberto: desconhecido");
  });
});

describe("summarizeMaintenance", () => {
  it("counts the board repair once and each part used for good", () => {
    expect(
      summarizeMaintenance([
        { tipo: "placa", descricao: "Troca do CI de áudio" },
        { tipo: "peca", peca: "Bateria", qtd: 1 },
        { tipo: "peca", peca: "Display", qtd: 2 },
      ]),
    ).toEqual({ count: 4, lines: ["Reparo em placa: Troca do CI de áudio", "Bateria", "Display (2)"] });
    expect(summarizeMaintenance([])).toEqual({ count: 0, lines: [] });
  });
});
