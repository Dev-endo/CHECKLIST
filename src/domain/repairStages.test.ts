import { describe, expect, it } from "vitest";
import { alertMessage, deviceWhereabouts, batchMessage, deliverableQty, groupByDevice, replaceableQty, returnsToStock, canCancelRequest, describeRepairError, formatDuration, isOpenRequest, liveTotals, pendingBalance, timerAction, type TimerTotals } from "./repairStages";

const totals = (over: Partial<TimerTotals> = {}): TimerTotals => ({ produtivo: 0, pausa: 0, espera_peca: 0, openKind: null, ...over });

describe("timer", () => {
  it("adds the elapsed time only to the open session", () => {
    expect(liveTotals(totals({ produtivo: 60, pausa: 10, openKind: "produtivo" }), 5)).toMatchObject({ produtivo: 65, pausa: 10 });
    expect(liveTotals(totals({ produtivo: 60, openKind: null }), 5).produtivo).toBe(60);
    expect(liveTotals(totals({ espera_peca: 3, openKind: "espera_peca" }), -4).espera_peca).toBe(3);
  });

  it("formats h:mm:ss", () => {
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(0)).toBe("0:00:00");
    expect(formatDuration(-3)).toBe("0:00:00");
  });

  it("offers start, pause or resume", () => {
    expect(timerAction(totals())).toEqual({ label: "Iniciar", next: "produtivo" });
    expect(timerAction(totals({ openKind: "produtivo" }))).toEqual({ label: "Pausar", next: "pausa" });
    expect(timerAction(totals({ pausa: 20, openKind: "pausa" }))).toEqual({ label: "Retomar", next: "produtivo" });
    expect(timerAction(totals({ espera_peca: 20, openKind: "espera_peca" }))).toEqual({ label: "Retomar", next: "produtivo" });
    expect(timerAction(totals({ produtivo: 30 }))).toEqual({ label: "Retomar", next: "produtivo" });
  });
});

describe("requests", () => {
  it("knows what is still open and cancellable", () => {
    expect(isOpenRequest("sem_estoque")).toBe(true);
    expect(isOpenRequest("entregue")).toBe(false);
    expect(canCancelRequest("pendente", 0)).toBe(true);
    expect(canCancelRequest("em_separacao", 2)).toBe(false);
    expect(canCancelRequest("cancelada", 0)).toBe(false);
    expect(pendingBalance(3, 2)).toBe(1);
  });

  it("explains database errors", () => {
    expect(describeRepairError({ code: "23505" }, "x")).toMatch(/teste/);
    expect(describeRepairError({ message: "no_os" }, "x")).toMatch(/OS/);
    expect(describeRepairError({ message: "outro" }, "falhou")).toBe("falhou");
  });
});

describe("batchMessage", () => {
  it("summarizes what was sent and what failed", () => {
    expect(batchMessage(1, [])).toBe("1 peça solicitada");
    expect(batchMessage(3, [])).toBe("3 peças solicitadas");
    expect(batchMessage(2, [{ part: "Bateria", message: "repetida" }])).toBe("2 peças solicitadas. Não enviadas: Bateria: repetida");
    expect(batchMessage(0, [{ part: "Bateria", message: "repetida" }])).toBe("Nenhuma peça enviada. Bateria: repetida");
  });
});

describe("stock board", () => {
  const req = (id: string, osId: string, createdAt: string, status: "pendente" | "entregue" = "pendente") => ({
    id,
    osId,
    osNumber: osId.toUpperCase(),
    serial: `S-${osId}`,
    status,
    createdAt,
  });

  it("groups by OS, oldest open request first", () => {
    const groups = groupByDevice([
      req("a", "os2", "2026-10-02T10:00:00Z"),
      req("b", "os1", "2026-10-01T09:00:00Z", "entregue"),
      req("c", "os1", "2026-10-03T09:00:00Z"),
      req("d", "os2", "2026-10-01T08:00:00Z"),
    ]);
    expect(groups.map((g) => g.osId)).toEqual(["os2", "os1"]);
    expect(groups[0]?.requests.map((r) => r.id)).toEqual(["d", "a"]);
  });

  it("computes balances and which returns go back to stock", () => {
    expect(deliverableQty(5, 2)).toBe(3);
    expect(deliverableQty(1, 3)).toBe(0);
    expect(replaceableQty(3, 1)).toBe(2);
    expect(returnsToStock("funcional")).toBe(true);
    expect(returnsToStock("com_defeito")).toBe(false);
    expect(returnsToStock("necessita_avaliacao")).toBe(false);
  });
});

describe("alertMessage", () => {
  it("names who asked and for what", () => {
    expect(alertMessage({ kind: "solicitacao", requester: "Ana", part: "Bateria", qty: 1, purpose: "teste" })).toBe("Ana solicitou Bateria para teste");
    expect(alertMessage({ kind: "solicitacao", requester: "Ana", part: "Display", qty: 3, purpose: "definitiva" })).toBe("Ana solicitou 3× Display para manutenção");
    expect(alertMessage({ kind: "devolucao", requester: "Ana", part: "Bateria", qty: 1, purpose: null })).toBe("Ana devolveu Bateria: confirme o recebimento");
  });
});

describe("deviceWhereabouts", () => {
  it("says where a device that already went through Stage 1 is", () => {
    expect(deviceWhereabouts({ evaluation: null, maintenance: null })).toBeNull();
    expect(deviceWhereabouts({ evaluation: { status: "concluida", destination: "vidro" }, maintenance: null })).toBe("no vidro");
    expect(deviceWhereabouts({ evaluation: { status: "concluida", destination: "analise" }, maintenance: null })).toBe("na Análise técnica");
    expect(deviceWhereabouts({ evaluation: { status: "concluida" }, maintenance: { status: "em_andamento" } })).toBe("no Estágio 2 (manutenção)");
    expect(deviceWhereabouts({ evaluation: null, maintenance: { status: "aguardando_pecas" } })).toBe("aguardando peças para o Estágio 2");
    expect(deviceWhereabouts({ evaluation: null, maintenance: { status: "concluida", outcome: "quarentena" } })).toBe("na quarentena");
    expect(deviceWhereabouts({ evaluation: null, maintenance: { status: "concluida", outcome: "revenda" } })).toBe("em revenda");
  });
});
