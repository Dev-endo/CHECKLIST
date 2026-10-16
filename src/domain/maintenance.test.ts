import { describe, expect, it } from "vitest";
import { blankDraft, toDeviceDoc } from "./device";
import {
  describeMaintenance,
  DISASSEMBLY_DESTINATIONS,
  parseBootIssue,
  TECHNICAL_DISASSEMBLY_DESTINATIONS,
  destinationLabel,
  destinationLabelFor,
  parseDestination,
  isMaintenanceComplete,
  MAINTENANCE_ITEMS,
  parseMaintenances,
  setMaintenanceDetail,
  toggleMaintenance,
} from "./maintenance";

describe("toggleMaintenance", () => {
  it("adds and removes items, keeping the order of the list", () => {
    let selected = toggleMaintenance([], "Tampa");
    selected = toggleMaintenance(selected, "Alto-falante");
    selected = toggleMaintenance(selected, "Placa");
    expect(selected.map((m) => m.item)).toEqual(["Alto-falante", "Placa", "Tampa"]);
    expect(toggleMaintenance(selected, "Placa").map((m) => m.item)).toEqual(["Alto-falante", "Tampa"]);
  });

  it("has every maintenance of the list exactly once", () => {
    expect(new Set(MAINTENANCE_ITEMS).size).toBe(MAINTENANCE_ITEMS.length);
    expect(MAINTENANCE_ITEMS).toHaveLength(27);
  });
});

describe("placa", () => {
  it("needs the service to be filled in", () => {
    const withPlaca = toggleMaintenance([], "Placa");
    expect(isMaintenanceComplete(withPlaca)).toBe(false);
    expect(isMaintenanceComplete(setMaintenanceDetail(withPlaca, "Placa", "  "))).toBe(false);
    expect(isMaintenanceComplete(setMaintenanceDetail(withPlaca, "Placa", "Troca de CI"))).toBe(true);
    expect(isMaintenanceComplete(toggleMaintenance([], "Limpeza"))).toBe(true);
  });

  it("describes the detail next to the item", () => {
    expect(describeMaintenance({ item: "Placa", detail: "Troca de CI" })).toBe("Placa: Troca de CI");
    expect(describeMaintenance({ item: "Limpeza" })).toBe("Limpeza");
  });
});

describe("parseMaintenances", () => {
  it("keeps valid entries and drops the rest", () => {
    expect(parseMaintenances([{ item: "Placa", detail: "x" }, { item: "Limpeza" }, null, { detail: "y" }, 3])).toEqual([
      { item: "Placa", detail: "x" },
      { item: "Limpeza" },
    ]);
    expect(parseMaintenances("nada")).toEqual([]);
  });
});

describe("toDeviceDoc maintenances", () => {
  it("carries the maintenances and defaults to none", () => {
    const now = "2026-02-01T00:00:00.000Z";
    expect(toDeviceDoc(blankDraft(), now).manutencoes).toEqual([]);
    expect(toDeviceDoc({ ...blankDraft(), manutencoes: [{ item: "Limpeza" }] }, now).manutencoes).toEqual([{ item: "Limpeza" }]);
  });
});

describe("destino", () => {
  it("labels and parses the two destinations", () => {
    expect(destinationLabel("montagem")).toBe("Liberado para montagem");
    expect(destinationLabel("vidro")).toBe("Enviado para vidro");
    expect(parseDestination("vidro")).toBe("vidro");
    expect(parseDestination("analise")).toBe("analise");
    expect(parseDestination("bloqueio")).toBe("bloqueio");
    expect(parseDestination("quarentena")).toBe("quarentena");
    expect(parseDestination("manutencao")).toBe("manutencao");
    expect(destinationLabel("manutencao")).toBe("Retorno para manutenção");
    expect(destinationLabel("bloqueio")).toBe("Liberado para bloqueio");
    expect(destinationLabel("quarentena")).toBe("Liberado para quarentena");
    expect(destinationLabel("analise")).toBe("Enviado para análise técnica");
    expect(parseDestination("outro")).toBeUndefined();
    expect(parseDestination(null)).toBeUndefined();
  });

  it("is saved with the checklist", () => {
    expect(toDeviceDoc({ ...blankDraft(), destino: "montagem" }, "2026-02-01T00:00:00.000Z").destino).toBe("montagem");
  });
});

describe("desmontagem", () => {
  it("knows the PT destination and the boot issues", () => {
    expect(parseDestination("pt")).toBe("pt");
    expect(destinationLabel("pt")).toBe("Enviado para PT");
    expect(parseBootIssue("looping")).toBe("looping");
    expect(parseBootIssue("x")).toBeUndefined();
  });

  it("knows the awaiting part destination", () => {
    expect(parseDestination("aguardando_peca")).toBe("aguardando_peca");
    expect(destinationLabel("aguardando_peca")).toBe("Aguardando peça");
  });

  it("offers analysis and PT only in the technical disassembly", () => {
    expect(DISASSEMBLY_DESTINATIONS.map((d) => d.id)).toEqual(["manutencao", "montagem"]);
    expect(TECHNICAL_DISASSEMBLY_DESTINATIONS.map((d) => d.id)).toEqual(["montagem", "pt", "manutencao", "analise"]);
  });
});

describe("destinationLabelFor", () => {
  it("says 'enviado' for the disassembly and 'retorno' for a rejected assembly", () => {
    expect(destinationLabelFor("desmontagem", "manutencao")).toBe("Enviado para manutenção");
    expect(destinationLabelFor("desmontagem_tecnica", "montagem")).toBe("Enviado para montagem");
    expect(destinationLabelFor("montagem", "manutencao")).toBe("Retorno para manutenção");
    expect(destinationLabelFor("manutencao", "montagem")).toBe("Liberado para montagem");
  });
});
