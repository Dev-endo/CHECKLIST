import { describe, expect, it } from "vitest";
import { accessibleTabs, canDoAssembly, canDoMaintenance } from "./roles";

describe("accessibleTabs", () => {
  it("gives each role only its own checklist", () => {
    expect(accessibleTabs("tecnico")).toEqual(["checklist"]);
    expect(accessibleTabs("montador")).toEqual(["montagem"]);
  });

  it("lets the admin open both checklists and manage users", () => {
    expect(accessibleTabs("admin")).toEqual(["checklist", "montagem", "registros", "admin"]);
  });

  it("lets the supervisor only consult", () => {
    expect(accessibleTabs("supervisor")).toEqual(["registros"]);
    expect(canDoMaintenance("supervisor")).toBe(false);
    expect(canDoAssembly("supervisor")).toBe(false);
  });

  it("gives nothing to who has no function yet", () => {
    expect(accessibleTabs("colaborador")).toEqual([]);
  });
});
