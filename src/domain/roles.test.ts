import { describe, expect, it } from "vitest";
import {
  accessibleTabs,
  ADMIN_ROLES,
  canCorrectOs,
  canDoAssembly,
  canDoMaintenance,
  canManageStock,
  canRegisterOs,
  canDirectFromGlass,
  canUseLabDay,
  canUseQuarantine,
  EXTRA_ROLES,
  ROLE_LABELS,
  receivesStockAlerts,
} from "./roles";

describe("accessibleTabs", () => {
  it("gives each function its tab, plus the Quarentena everyone shares", () => {
    expect(accessibleTabs("tecnico")).toEqual(["checklist_manutencao", "quarentena", "defeito_incorreto"]);
    expect(accessibleTabs("estoquista")).toEqual(["quarentena", "defeito_incorreto", "solicitacoes", "os"]);
    expect(accessibleTabs("analista")).toEqual(["defeito_incorreto", "analise_tecnica"]);
    expect(accessibleTabs(["analista", "tecnico"])).toEqual(["checklist_manutencao", "quarentena", "defeito_incorreto", "analise_tecnica"]);
    expect(accessibleTabs("tecnico_vidro")).toEqual(["quarentena", "defeito_incorreto", "vidro"]);
    expect(accessibleTabs("supervisor")).toEqual(["quarentena", "reprovados", "defeito_incorreto", "dashboard", "aprovacao_pt", "dia_lab_entrega", "dia_lab_acompanhamento"]);
    expect(canRegisterOs("estoquista")).toBe(false);
    expect(canRegisterOs("tecnico")).toBe(true);
  });

  it("lets the admin open every tab and manage users", () => {
    expect(accessibleTabs("admin")).toEqual([
      "reparo",
      "reparo2",
      "checklist_manutencao",
      "quarentena", "reprovados", "defeito_incorreto",
      "analise_tecnica",
      "vidro",
      "solicitacoes",
      "os",
      "dashboard",
      "aprovacao_pt",
      "dia_lab_entrega",
      "dia_lab_acompanhamento",
      "liberacao",
      "admin",
    ]);
  });

  it("no longer shows the old screens (manutenção, desmontagem, montagem, análise antiga)", () => {
    for (const tab of ["checklist", "desmontagem", "desmontagem_tecnica", "montagem", "registros", "estoque", "emprestimos"] as const) {
      expect(accessibleTabs("admin")).not.toContain(tab);
    }
    expect(accessibleTabs("desmontador")).toEqual(["quarentena", "defeito_incorreto"]);
    expect(accessibleTabs("montador")).toEqual(["quarentena", "defeito_incorreto"]);
  });

  it("lets the supervisor only see the results", () => {
    expect(canDoMaintenance("supervisor")).toBe(false);
    expect(canDoAssembly("supervisor")).toBe(false);
    expect(canManageStock("supervisor")).toBe(false);
    expect(canCorrectOs("estoquista")).toBe(false);
    expect(canCorrectOs("admin")).toBe(true);
  });

  it("adds up the tabs of every function a person has", () => {
    expect(accessibleTabs(["tecnico", "tecnico_vidro"])).toEqual(["checklist_manutencao", "quarentena", "defeito_incorreto", "vidro"]);
    expect(accessibleTabs(["estoquista", "supervisor"])).toEqual(["quarentena", "reprovados", "defeito_incorreto", "solicitacoes", "os", "dashboard", "aprovacao_pt", "dia_lab_entrega", "dia_lab_acompanhamento"]);
  });

  it("gives nothing to who has no function yet", () => {
    expect(accessibleTabs("colaborador")).toEqual([]);
    expect(canUseQuarantine("colaborador")).toBe(false);
  });
});

describe("Reparo e Análise técnica", () => {
  it("shows Reparo only to the admin and the analysis checklist only to the analyst", () => {
    expect(accessibleTabs("tecnico")).not.toContain("reparo");
    expect(accessibleTabs("admin")).toContain("reparo");
    expect(accessibleTabs("admin")).toContain("analise_tecnica");
    expect(accessibleTabs(["admin", "analista"])).toContain("analise_tecnica");
    expect(accessibleTabs("tecnico")).not.toContain("analise_tecnica");
  });
});

describe("Reprovados", () => {
  it("is only for supervisor and admin", () => {
    for (const role of ["tecnico", "tecnico_vidro", "analista", "estoquista", "montador", "desmontador"] as const) {
      expect(accessibleTabs(role)).not.toContain("reprovados");
    }
    expect(accessibleTabs("supervisor")).toContain("reprovados");
    expect(accessibleTabs("admin")).toContain("reprovados");
  });
});

describe("Dia Laboratório", () => {
  it("is only for supervisor and admin; the glass technician only directs from the glass", () => {
    expect(canUseLabDay("supervisor")).toBe(true);
    expect(canUseLabDay("admin")).toBe(true);
    for (const role of ["tecnico", "tecnico_vidro", "montador", "desmontador", "analista", "estoquista", "colaborador"] as const) {
      expect(canUseLabDay(role)).toBe(false);
      expect(accessibleTabs(role)).not.toContain("dia_lab_entrega");
    }
    expect(canDirectFromGlass("tecnico_vidro")).toBe(true);
    expect(canDirectFromGlass("supervisor")).toBe(true);
    expect(canDirectFromGlass("tecnico")).toBe(false);
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
