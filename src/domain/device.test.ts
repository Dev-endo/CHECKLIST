import { describe, expect, it } from "vitest";
import { ALL_ITEMS } from "./checklist";
import {
  blankDraft,
  computeStats,
  findDuplicate,
  isEditable,
  isIdentified,
  toDeviceDoc,
  TOTAL_TESTS,
  type Results,
} from "./device";

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

describe("findDuplicate (fase)", () => {
  it("prefers a pending record over a concluded one", () => {
    const draft = { ...blankDraft(), serial: "abc" };
    const records = [
      { id: "done", serial: "abc", fase: "concluido" as const },
      { id: "open", serial: "abc", fase: "pendente" as const },
    ];
    expect(findDuplicate(draft, records)?.id).toBe("open");
  });

  it("falls back to a concluded record when none is pending", () => {
    const draft = { ...blankDraft(), serial: "abc" };
    expect(findDuplicate(draft, [{ id: "done", serial: "abc", fase: "concluido" as const }])?.id).toBe("done");
  });
});

describe("isIdentified", () => {
  it("needs model, serial and technician", () => {
    expect(isIdentified({ modelo: "iPhone 13", serial: "1", tec: "Ana" })).toBe(true);
    expect(isIdentified({ modelo: "iPhone 13", serial: " ", tec: "Ana" })).toBe(false);
    expect(isIdentified({ modelo: "", serial: "1", tec: "Ana" })).toBe(false);
    expect(isIdentified({ modelo: "iPhone 13", serial: "1", tec: "" })).toBe(false);
  });
});

describe("isEditable", () => {
  it("allows only pending checklists of the logged user", () => {
    const draft = blankDraft();
    expect(isEditable(draft, "u1")).toBe(true);
    expect(isEditable({ ...draft, autor: "u1" }, "u1")).toBe(true);
    expect(isEditable({ ...draft, autor: "u2" }, "u1")).toBe(false);
    expect(isEditable({ ...draft, autor: "u1", fase: "concluido" }, "u1")).toBe(false);
  });
});

describe("toDeviceDoc fase", () => {
  it("carries the phase and trims identification fields", () => {
    const draft = { ...blankDraft(), modelo: " iPhone ", serial: " 1 ", tec: " Ana ", fase: "concluido" as const };
    expect(toDeviceDoc(draft, "2026-02-01T00:00:00.000Z")).toMatchObject({
      fase: "concluido",
      modelo: "iPhone",
      serial: "1",
      tec: "Ana",
    });
  });
});
