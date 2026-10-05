import { describe, expect, it } from "vitest";
import { ALL_ITEMS } from "./checklist";
import { blankDraft, computeStats, findDuplicate, toDeviceDoc, TOTAL_TESTS, type Results } from "./device";
import { buildReport } from "./report";

const allOk = (): Results => Object.fromEntries(ALL_ITEMS.map((item) => [item.id, "ok" as const]));

describe("computeStats", () => {
  it("is incompleto with no results", () => {
    expect(computeStats({})).toMatchObject({ done: 0, status: "incompleto" });
  });

  it("is liberado when every test passes", () => {
    expect(computeStats(allOk())).toMatchObject({ done: TOTAL_TESTS, status: "liberado" });
  });

  it("is reprovado on any failure, even if incomplete", () => {
    const stats = computeStats({ touch: "fail" });
    expect(stats.status).toBe("reprovado");
    expect(stats.fails.map((f) => f.id)).toEqual(["touch"]);
  });

  it("ignores cleared results", () => {
    expect(computeStats({ touch: "" }).done).toBe(0);
  });
});

describe("toDeviceDoc", () => {
  it("keeps the original creation date", () => {
    const draft = { ...blankDraft(), criado: "2026-01-01T00:00:00.000Z" };
    const doc = toDeviceDoc(draft, "2026-02-01T00:00:00.000Z");
    expect(doc.criado).toBe("2026-01-01T00:00:00.000Z");
    expect(doc.atualizado).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("findDuplicate", () => {
  it("matches serials ignoring case and whitespace, but not itself", () => {
    const draft = { ...blankDraft(), serial: " ABC " };
    expect(findDuplicate(draft, [{ id: draft.id, serial: "abc" }])).toBeUndefined();
    expect(findDuplicate(draft, [{ id: "x", serial: "abc" }])?.id).toBe("x");
  });
});

describe("buildReport", () => {
  it("lists failures", () => {
    const draft = { ...blankDraft("Ana"), modelo: "iPhone 13", r: { ...allOk(), flash: "fail" as const } };
    const report = buildReport(draft);
    expect(report).toContain("Resultado: REPROVADO");
    expect(report).toContain("Falhas: Flash e lanterna");
    expect(report).toContain("Técnico: Ana");
  });

  it("lists pending tests when nothing failed", () => {
    expect(buildReport(blankDraft())).toContain("Não testados:");
  });
});
