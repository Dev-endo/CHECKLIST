import { describe, expect, it } from "vitest";
import { countSwaps, countSwapsByPerson, modelWithoutMemory, openParts, parseAllocationStatus, parseRequestKind, requestMessage, sortByCatalog, requestBlocksConclusion, STOCK_PARTS, testPartBlocksConclusion, undecidedParts } from "./stock";

describe("STOCK_PARTS", () => {
  it("lists the maintenance items that use a part", () => {
    expect(STOCK_PARTS).toContain("Display");
    expect(STOCK_PARTS).toContain("Bateria");
    expect(STOCK_PARTS).not.toContain("Limpeza");
    expect(STOCK_PARTS).not.toContain("Software");
  });
});

describe("allocations", () => {
  it("reads unknown statuses as allocated on the device", () => {
    expect(parseAllocationStatus("trocada")).toBe("trocada");
    expect(parseAllocationStatus("???")).toBe("liberada");
    expect(parseAllocationStatus(null)).toBe("liberada");
  });

  it("keeps only the parts still with the technician", () => {
    const list = [{ status: "liberada" as const }, { status: "devolvida" as const }, { status: "concluida" as const }];
    expect(openParts(list)).toEqual([{ status: "liberada" }]);
  });
});

describe("requests", () => {
  it("words the stockist alert with the collaborator's name", () => {
    expect(requestMessage("Ana", "teste")).toBe("Ana solicitou peça para teste");
    expect(requestMessage("Ana", "nova")).toBe("Ana solicitou peça para manutenção");
    expect(requestMessage("Ana", "troca")).toBe("Ana solicitou troca de peça");
    expect(requestMessage("Ana", "uso")).toBe("Ana pediu liberação da peça de teste para uso");
    expect(requestMessage("Ana", "devolucao")).toBe("Ana devolveu a peça de teste");
    expect(parseRequestKind("???")).toBe("nova");
    expect(parseRequestKind("uso")).toBe("uso");
  });

  it("finds the parts the technician has not decided yet", () => {
    const open = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(undecidedParts(open, { a: "concluir" }, new Set(["b"]))).toEqual([{ id: "c" }]);
  });

  it("keeps maintenances in catalog order", () => {
    expect(sortByCatalog([{ item: "Tampa" }, { item: "Bateria" }])).toEqual([{ item: "Bateria" }, { item: "Tampa" }]);
  });
});

describe("test part lock", () => {
  it("blocks the maintenance checklist while a test part is still lent", () => {
    expect(testPartBlocksConclusion([{ status: "emprestada" }])).toBe(true);
    expect(testPartBlocksConclusion([{ status: "devolvida" }, { status: "em_uso" }])).toBe(false);
    expect(testPartBlocksConclusion([])).toBe(false);
  });
});

describe("request lock", () => {
  it("blocks the maintenance checklist while the stockist has not answered a request", () => {
    expect(requestBlocksConclusion([{ kind: "nova" }])).toBe(true);
    expect(requestBlocksConclusion([{ kind: "troca" }])).toBe(true);
    expect(requestBlocksConclusion([{ kind: "uso" }, { kind: "devolucao" }])).toBe(false);
    expect(requestBlocksConclusion([])).toBe(false);
  });
});

describe("swapped parts", () => {
  it("drops the memory from the model", () => {
    expect(modelWithoutMemory("iPhone 15 Pro 256GB")).toBe("iPhone 15 Pro");
    expect(modelWithoutMemory("iPhone 15 1TB")).toBe("iPhone 15");
    expect(modelWithoutMemory("iPhone 14")).toBe("iPhone 14");
    expect(modelWithoutMemory(null)).toBe("Modelo não encontrado");
  });

  it("counts by part and model, ignoring the memory", () => {
    const rows = [
      { part: "Display", model: "iPhone 15 128GB" },
      { part: "Display", model: "iPhone 15 256GB" },
      { part: "Bateria", model: "iPhone 15 128GB" },
    ];
    expect(countSwaps(rows)).toEqual([
      { part: "Display", model: "iPhone 15", count: 2 },
      { part: "Bateria", model: "iPhone 15", count: 1 },
    ]);
  });

  it("groups by technician, most mistakes first", () => {
    const row = (userId: string, person: string, part: string) => ({
      reason: "erro_tecnico" as const,
      part,
      model: "iPhone 15 128GB",
      person,
      userId,
      at: "2026-10-27T10:00:00Z",
    });
    const result = countSwapsByPerson([row("a", "Ana", "Display"), row("b", "Bia", "Tampa"), row("b", "Bia", "Display")]);
    expect(result.map((p) => [p.person, p.total])).toEqual([
      ["Bia", 2],
      ["Ana", 1],
    ]);
  });
});
