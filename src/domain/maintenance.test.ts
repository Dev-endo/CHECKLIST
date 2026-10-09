import { describe, expect, it } from "vitest";
import { blankDraft, toDeviceDoc } from "./device";
import {
  describeMaintenance,
  destinationLabel,
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
    expect(destinationLabel("analise")).toBe("Enviado para análise técnica");
    expect(parseDestination("outro")).toBeUndefined();
    expect(parseDestination(null)).toBeUndefined();
  });

  it("is saved with the checklist", () => {
    expect(toDeviceDoc({ ...blankDraft(), destino: "montagem" }, "2026-02-01T00:00:00.000Z").destino).toBe("montagem");
  });
});
