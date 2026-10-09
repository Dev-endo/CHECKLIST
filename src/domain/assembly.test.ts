import { describe, expect, it } from "vitest";
import { ASSEMBLY_CHECKLIST } from "./assemblyChecklist";
import { catalogFor } from "./catalogs";
import {
  blankDraft,
  computeStats,
  describeFailures,
  missingConfirmations,
  setConfirmation,
  toDeviceDoc,
  toggleItemFailure,
  toggleSectionResult,
  totalTests,
  type Results,
} from "./device";
import { blameLabel, parseBlame } from "./maintenance";
import { describeAssemblyBlock } from "../services/supabase/assemblyService";

const allOk = (): Results =>
  Object.fromEntries(
    ASSEMBLY_CHECKLIST.filter((block) => !block.confirmOnly).map((block) => [block.id, "ok" as const]),
  );

describe("checklist de montagem", () => {
  it("has the topics with unique ids", () => {
    expect(ASSEMBLY_CHECKLIST.map((block) => block.title)).toEqual([
      "Display",
      "Câmeras",
      "Lentes da câmera",
      "Proximidade",
      "Reiniciar",
      "Conferência de IMEI",
    ]);
    const ids = ASSEMBLY_CHECKLIST.flatMap((block) => [block.id, ...block.items.map((item) => item.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ASSEMBLY_CHECKLIST.find((block) => block.title === "Lentes da câmera")?.items).toHaveLength(4);
  });

  it("is selected by kind and counted by its own topics", () => {
    expect(catalogFor("montagem")).toBe(ASSEMBLY_CHECKLIST);
    expect(totalTests("montagem")).toBe(5);
    expect(totalTests()).toBeGreaterThan(5);
  });

  it("is liberado when every topic is OK, reprovado on any failure", () => {
    expect(computeStats(allOk(), "montagem")).toMatchObject({ done: 5, status: "liberado" });
    expect(computeStats({ ...allOk(), reiniciar: "fail" }, "montagem")).toMatchObject({ status: "reprovado" });
    expect(computeStats({}, "montagem").status).toBe("incompleto");
  });

  it("has the IMEI check as a confirmation only, without OK or Falha", () => {
    const imei = ASSEMBLY_CHECKLIST.find((block) => block.title === "Conferência de IMEI");
    expect(imei?.confirmOnly).toBe(true);
    expect(computeStats({}, "montagem").pending.map((s) => s.title)).not.toContain("Conferência de IMEI");
  });

  it("requires the IMEI confirmation to conclude", () => {
    expect(missingConfirmations({}, "montagem").map((item) => item.id)).toEqual(["m-imei"]);
    expect(missingConfirmations(setConfirmation({}, "m-imei", true), "montagem")).toEqual([]);
  });

  it("lets the failed item be pointed and describes the failure", () => {
    const failed = toggleSectionResult({}, "lentes-da-camera", "fail", "montagem");
    const marked = toggleItemFailure(failed, "lentes-da-camera", "m-lente-frontal-adesivo");
    expect(describeFailures(marked, "montagem")).toEqual(["Lentes da câmera: Câmera frontal sem adesivo"]);
    expect(toggleSectionResult(marked, "lentes-da-camera", "ok", "montagem")).toEqual({ "lentes-da-camera": "ok" });
  });

  it("saves kind, blame, parts and origin with the checklist", () => {
    const draft = {
      ...blankDraft("Ana", "montagem"),
      culpa: "manutencao" as const,
      pecas: [{ item: "Display" }],
      origem: "abc",
    };
    expect(toDeviceDoc(draft, "2026-02-01T00:00:00.000Z")).toMatchObject({
      tipo: "montagem",
      culpa: "manutencao",
      pecas: [{ item: "Display" }],
      origem: "abc",
    });
    expect(blankDraft().tipo).toBe("manutencao");
  });
});

describe("culpa", () => {
  it("labels and parses the blame", () => {
    expect(blameLabel("montagem")).toBe("Erro de montagem");
    expect(blameLabel("manutencao")).toBe("Erro de manutenção");
    expect(parseBlame("manutencao")).toBe("manutencao");
    expect(parseBlame("x")).toBeUndefined();
  });
});

describe("describeAssemblyBlock", () => {
  const ok = { deviceId: "d", destination: "montagem", status: "liberado" as const, technician: "Ana" };

  it("lets only devices released for assembly by the last maintenance checklist in", () => {
    expect(describeAssemblyBlock(ok)).toBeNull();
    expect(describeAssemblyBlock(null)).toMatch(/não passou/);
    expect(describeAssemblyBlock({ ...ok, status: "reprovado" })).toMatch(/não o liberou/);
    expect(describeAssemblyBlock({ ...ok, destination: "vidro" })).toMatch(/vidro/);
    expect(describeAssemblyBlock({ ...ok, status: "reprovado", destination: "analise" })).toMatch(/análise técnica/);
  });
});
