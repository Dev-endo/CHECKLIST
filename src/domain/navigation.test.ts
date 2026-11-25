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
      ["Reprovados", ["reprovados"]],
      ["Defeito incorreto", ["defeito_incorreto"]],
      ["Análise técnica", ["analise_tecnica"]],
      ["Vidro", ["vidro"]],
      ["Estoque", ["solicitacoes", "os"]],
      ["Análise", ["dashboard"]],
      ["Aprovação PT", ["aprovacao_pt"]],
      ["Dia Laboratório", ["dia_lab_entrega", "dia_lab_acompanhamento"]],
      ["Liberação", ["liberacao"]],
      ["Administração", ["admin"]],
    ]);
  });

  it("shows each function its own group", () => {
    expect(summary("tecnico")).toEqual([
      ["Checklist manutenção", ["checklist_manutencao"]],
      ["Quarentena", ["quarentena"]],
      ["Defeito incorreto", ["defeito_incorreto"]],
    ]);
    expect(summary("estoquista")).toEqual([
      ["Quarentena", ["quarentena"]],
      ["Defeito incorreto", ["defeito_incorreto"]],
      ["Estoque", ["solicitacoes", "os"]],
    ]);
    expect(summary("analista")).toEqual([
      ["Defeito incorreto", ["defeito_incorreto"]],
      ["Análise técnica", ["analise_tecnica"]],
    ]);
    expect(summary("tecnico_vidro")).toEqual([
      ["Quarentena", ["quarentena"]],
      ["Defeito incorreto", ["defeito_incorreto"]],
      ["Vidro", ["vidro"]],
    ]);
    expect(summary("supervisor")).toEqual([
      ["Quarentena", ["quarentena"]],
      ["Reprovados", ["reprovados"]],
      ["Defeito incorreto", ["defeito_incorreto"]],
      ["Análise", ["dashboard"]],
      ["Aprovação PT", ["aprovacao_pt"]],
      ["Dia Laboratório", ["dia_lab_entrega", "dia_lab_acompanhamento"]],
    ]);
  });

  it("is empty for who has no function yet", () => {
    expect(summary("colaborador")).toEqual([]);
  });

  it("has exactly one Quarentena tab for every role that has a function", () => {
    const roles: UserRole[] = ["admin", "supervisor", "tecnico", "desmontador", "montador", "estoquista", "tecnico_vidro"];
    for (const role of roles) {
      expect(accessibleTabs(role).filter((tab) => tab === "quarentena")).toHaveLength(1);
    }
  });
});
