import { describe, expect, it } from "vitest";
import {
  accessibleTabs,
  ADMIN_ROLES,
  canCorrectOs,
  canDoAssembly,
  canDoMaintenance,
  canManageStock,
  canRegisterOs,
  canUseQuarantine,
  EXTRA_ROLES,
  ROLE_LABELS,
  receivesStockAlerts,
} from "./roles";

describe("accessibleTabs", () => {
  it("gives each function its tab, plus the Quarentena everyone shares", () => {
    expect(accessibleTabs("tecnico")).toEqual(["reparo", "reparo2", "checklist_manutencao", "quarentena"]);
    expect(accessibleTabs("estoquista")).toEqual(["quarentena", "solicitacoes", "os"]);
    expect(accessibleTabs("analista")).toEqual(["quarentena", "analise_tecnica", "reparo_placa", "analise_montagem"]);
    expect(accessibleTabs("tecnico_vidro")).toEqual(["quarentena", "vidro"]);
    expect(accessibleTabs("supervisor")).toEqual(["quarentena", "dashboard"]);
    expect(canRegisterOs("estoquista")).toBe(false);
    expect(canRegisterOs("tecnico")).toBe(true);
  });

  it("lets the admin open every tab and manage users", () => {
    expect(accessibleTabs("admin")).toEqual([
      "reparo",
      "reparo2",
      "checklist_manutencao",
      "quarentena",
      "analise_tecnica",
      "reparo_placa",
      "analise_montagem",
      "vidro",
      "solicitacoes",
      "os",
      "dashboard",
      "admin",
    ]);
  });

  it("no longer shows the old screens (manutenção, desmontagem, montagem, análise antiga)", () => {
    for (const tab of ["checklist", "desmontagem", "desmontagem_tecnica", "montagem", "registros", "estoque", "emprestimos"] as const) {
      expect(accessibleTabs("admin")).not.toContain(tab);
    }
    expect(accessibleTabs("desmontador")).toEqual(["quarentena"]);
    expect(accessibleTabs("montador")).toEqual(["quarentena"]);
  });

  it("lets the supervisor only see the results", () => {
    expect(canDoMaintenance("supervisor")).toBe(false);
    expect(canDoAssembly("supervisor")).toBe(false);
    expect(canManageStock("supervisor")).toBe(false);
    expect(canCorrectOs("estoquista")).toBe(false);
    expect(canCorrectOs("admin")).toBe(true);
  });

  it("adds up the tabs of every function a person has", () => {
    expect(accessibleTabs(["tecnico", "tecnico_vidro"])).toEqual(["reparo", "reparo2", "checklist_manutencao", "quarentena", "vidro"]);
    expect(accessibleTabs(["estoquista", "supervisor"])).toEqual(["quarentena", "solicitacoes", "os", "dashboard"]);
  });

  it("gives nothing to who has no function yet", () => {
    expect(accessibleTabs("colaborador")).toEqual([]);
    expect(canUseQuarantine("colaborador")).toBe(false);
  });
});

describe("notifications", () => {
  it("only the stock function receives stock alerts, even for the admin", () => {
    expect(receivesStockAlerts("estoquista")).toBe(true);
    expect(receivesStockAlerts(["admin", "estoquista"])).toBe(true);
    expect(receivesStockAlerts("admin")).toBe(false);
    expect(receivesStockAlerts("supervisor")).toBe(false);
  });
});

describe("administração", () => {
  it("offers the new functions, which can be combined", () => {
    expect(ADMIN_ROLES).toEqual(["admin", "supervisor", "tecnico", "analista", "tecnico_vidro", "estoquista", "colaborador"]);
    expect(EXTRA_ROLES).toEqual(["tecnico", "analista", "tecnico_vidro", "estoquista", "supervisor"]);
    expect(ROLE_LABELS.analista).toBe("Técnico de placa");
    expect(ROLE_LABELS.tecnico_vidro).toBe("Técnico de vidro");
  });
});
