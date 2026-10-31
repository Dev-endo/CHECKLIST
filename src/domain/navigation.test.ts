import { describe, expect, it } from "vitest";
import { navGroups } from "./navigation";
import { accessibleTabs, type UserRole } from "./roles";

const summary = (roles: Parameters<typeof accessibleTabs>[0]) =>
  navGroups(accessibleTabs(roles)).map((group) => [group.label, group.tabs]);

describe("navGroups", () => {
  it("keeps only Reparo, Checklist manutenção, Quarentena, Análise técnica, Vidro, Estoque and Análise (plus Administração for the admin)", () => {
    expect(summary("admin")).toEqual([
      ["Reparo", ["reparo", "reparo2"]],
      ["Checklist manutenção", ["checklist_manutencao"]],
      ["Quarentena", ["quarentena"]],
      ["Análise técnica", ["analise_tecnica", "reparo_placa", "analise_montagem"]],
      ["Vidro", ["vidro"]],
      ["Estoque", ["solicitacoes", "os"]],
      ["Análise", ["dashboard"]],
      ["Administração", ["admin"]],
    ]);
  });

  it("shows each function its own group", () => {
    expect(summary("tecnico")).toEqual([
      ["Reparo", ["reparo", "reparo2"]],
      ["Checklist manutenção", ["checklist_manutencao"]],
      ["Quarentena", ["quarentena"]],
    ]);
    expect(summary("estoquista")).toEqual([
      ["Quarentena", ["quarentena"]],
      ["Estoque", ["solicitacoes", "os"]],
    ]);
    expect(summary("analista")).toEqual([
      ["Quarentena", ["quarentena"]],
      ["Análise técnica", ["analise_tecnica", "reparo_placa", "analise_montagem"]],
    ]);
    expect(summary("tecnico_vidro")).toEqual([
      ["Quarentena", ["quarentena"]],
      ["Vidro", ["vidro"]],
    ]);
    expect(summary("supervisor")).toEqual([
      ["Quarentena", ["quarentena"]],
      ["Análise", ["dashboard"]],
    ]);
  });

  it("is empty for who has no function yet", () => {
    expect(summary("colaborador")).toEqual([]);
  });

  it("has exactly one Quarentena tab for every role that has a function", () => {
    const roles: UserRole[] = ["admin", "supervisor", "tecnico", "desmontador", "montador", "estoquista", "analista", "tecnico_vidro"];
    for (const role of roles) {
      expect(accessibleTabs(role).filter((tab) => tab === "quarentena")).toHaveLength(1);
    }
  });
});
