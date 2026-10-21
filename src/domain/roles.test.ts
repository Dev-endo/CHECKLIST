import { describe, expect, it } from "vitest";
import { accessibleTabs, canDoAssembly, canDoMaintenance } from "./roles";

describe("accessibleTabs", () => {
  it("gives each role only its own checklist", () => {
    expect(accessibleTabs("tecnico")).toEqual(["checklist", "os"]);
    expect(accessibleTabs("desmontador")).toEqual(["desmontagem", "desmontagem_tecnica", "os"]);
    expect(accessibleTabs("montador")).toEqual(["montagem", "quarentena", "os"]);
  });

  it("lets the admin open both checklists and manage users", () => {
    expect(accessibleTabs("admin")).toEqual(["checklist", "desmontagem", "desmontagem_tecnica", "montagem", "quarentena", "registros", "os", "admin"]);
  });

  it("lets the supervisor only consult", () => {
    expect(accessibleTabs("supervisor")).toEqual(["registros", "os"]);
    expect(canDoMaintenance("supervisor")).toBe(false);
    expect(canDoAssembly("supervisor")).toBe(false);
  });

  it("adds up the tabs of every role a person has", () => {
    expect(accessibleTabs(["tecnico", "montador"])).toEqual(["checklist", "montagem", "quarentena", "os"]);
    expect(accessibleTabs(["desmontador", "tecnico", "montador"])).toEqual([
      "checklist",
      "desmontagem",
      "desmontagem_tecnica",
      "montagem",
      "quarentena",
      "os",
    ]);
  });

  it("gives nothing to who has no function yet", () => {
    expect(accessibleTabs("colaborador")).toEqual([]);
  });
});
