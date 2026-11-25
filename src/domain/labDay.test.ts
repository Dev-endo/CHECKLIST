import { describe, expect, it } from "vitest";
import {
  deskLabel,
  goalReached,
  labOverview,
  parseSerials,
  previewRows,
  technicianSummaries,
  toCsv,
  validSerials,
  type BalloonRow,
  type BoardAsset,
  type SerialCheck,
  type TechnicianSummary,
} from "./labDay";

const from = new Date("2026-11-25T03:00:00Z");
const to = new Date("2026-11-26T03:00:00Z");
const today = "2026-11-25T15:00:00Z";
const yesterday = "2026-11-24T15:00:00Z";

describe("parseSerials", () => {
  it("accepts scanner Enter, pasted lines, commas, semicolons and spaces", () => {
    expect(parseSerials("A1\nA2\r\nA3, A4;A5  A6\t A7\n\n")).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7"]);
    expect(parseSerials("   ")).toEqual([]);
  });
});

describe("previewRows", () => {
  const check = (serial: string, extra: Partial<SerialCheck> = {}): [string, SerialCheck] => [
    serial.toLowerCase(),
    { serial, found: true, unit: `U-${serial}`, model: "iPhone", labStatus: null, holder: null, ...extra },
  ];
  const checks = new Map([check("A1"), check("A2", { holder: "Ana" }), check("A3", { found: false, unit: null }), check("A4", { labStatus: "vidro" })]);

  it("warns about duplicated, not found and already taken serials", () => {
    const rows = previewRows(["A1", "a1", "A2", "A3", "A4"], checks);
    expect(rows.map((row) => row.problem)).toEqual([null, "duplicado", "com_tecnico", "nao_encontrado", null]);
    expect(rows[0]?.unit).toBe("U-A1");
    expect(validSerials(rows)).toEqual(["A1", "A4"]);
  });

  it("only accepts glass assets when directing from the glass", () => {
    const rows = previewRows(["A1", "A4"], checks, true);
    expect(rows.map((row) => row.problem)).toEqual(["fora_do_vidro", null]);
  });
});

const asset = (serial: string, extra: Partial<BoardAsset>): BoardAsset => ({
  id: serial,
  serial,
  unit: `U-${serial}`,
  status: "aguardando_manutencao",
  technician: "Tec",
  lastTechnician: null,
  enteredAt: today,
  exitedAt: null,
  rejectedAt: null,
  lastMoveAt: today,
  osNumber: null,
  ...extra,
});

const balloon = (serial: string, extra: Partial<BalloonRow>): BalloonRow => ({
  id: `${serial}-${extra.status ?? "aberto"}-${extra.technicianId ?? "t1"}`,
  serial,
  unit: `U-${serial}`,
  technicianId: "t1",
  technician: "Tec",
  status: "aberto",
  source: "entrega",
  fromName: "Sup",
  transferredTo: null,
  outcome: null,
  createdAt: today,
  confirmedAt: today,
  finishedAt: null,
  osNumber: null,
  ...extra,
});

describe("labOverview", () => {
  const board = [
    asset("B1", {}),
    asset("B2", { status: "pt", exitedAt: today, technician: null, lastTechnician: "Tec" }),
    asset("B3", { status: "quarentena_aprovada", exitedAt: today }),
    asset("B4", { status: "revenda", exitedAt: today }),
    asset("B5", { status: "bloqueado", exitedAt: today }),
    asset("B6", { status: "vidro" }),
    asset("B7", { status: "analise", enteredAt: yesterday }),
    asset("B8", { status: "quarentena" }),
    asset("B9", { status: "reprovado_aguardando", rejectedAt: today }),
    asset("B10", { status: "transferencia_pendente" }),
    asset("B11", { status: "quarentena_aprovada", exitedAt: yesterday, enteredAt: yesterday }),
  ];
  const balloons = [
    balloon("B2", { status: "finalizado", outcome: "pt", finishedAt: today }),
    balloon("B4", { status: "finalizado", outcome: "revenda", finishedAt: today }),
    balloon("B6", { status: "finalizado", outcome: "vidro", finishedAt: today }),
    balloon("B8", { status: "finalizado", outcome: "quarentena", finishedAt: today }),
    balloon("B11", { status: "finalizado", outcome: "quarentena", finishedAt: yesterday }),
  ];
  const groups = labOverview(board, balloons, from, to);
  const count = (id: keyof typeof groups) => groups[id].length;

  it("counts what entered and what left (only PT and approved quarantine)", () => {
    expect(count("entraram")).toBe(9);
    expect(groups.sairam.map((row) => row.serial).sort()).toEqual(["B2", "B3"]);
  });

  it("counts the destinations of the period", () => {
    expect([count("destino_pt"), count("destino_revenda"), count("destino_vidro"), count("destino_quarentena"), count("destino_bloqueado")]).toEqual([1, 1, 1, 1, 0]);
    expect([count("quarentena_aguardando"), count("quarentena_aprovada"), count("quarentena_reprovada")]).toEqual([1, 1, 1]);
  });

  it("keeps glass, analysis, quarantine, rejected and pending transfers inside the lab", () => {
    expect(count("lab_total")).toBe(6);
    expect([count("lab_vidro"), count("lab_aguardando"), count("lab_analise"), count("lab_quarentena"), count("lab_reprovados"), count("lab_pendentes")]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(groups.lab_total.some((row) => row.serial === "B4" || row.serial === "B5")).toBe(false);
  });

  it("lists serial, Unit ID, OS, technician, status and last move", () => {
    expect(groups.sairam.find((row) => row.serial === "B2")).toEqual({ serial: "B2", unit: "U-B2", os: null, technician: "Tec", status: "PT", at: today });
  });

  it("counts a serial in only one destination (the last one) per OS", () => {
    const later = "2026-11-25T18:00:00Z";
    const dest = labOverview(
      [],
      [
        balloon("F1", { id: "f1", status: "finalizado", outcome: "vidro", finishedAt: today, osNumber: "OS-1" }),
        balloon("F1", { id: "f2", status: "finalizado", outcome: "quarentena", finishedAt: later, osNumber: "OS-1" }),
        balloon("F1", { id: "f3", status: "finalizado", outcome: "analise", finishedAt: today, osNumber: "OS-2" }),
      ],
      from,
      to,
    );
    expect([dest.destino_vidro.length, dest.destino_quarentena.length, dest.destino_analise.length]).toEqual([0, 1, 1]);
  });

  it("counts the same serial only once per OS", () => {
    const later = "2026-11-25T18:00:00Z";
    const repeated = labOverview(
      [
        asset("D1", { id: "p1", osNumber: "OS-1" }),
        asset("D1", { id: "p2", osNumber: "OS-1", lastMoveAt: later }),
        asset("D1", { id: "p3", osNumber: null }),
        asset("D2", { id: "p4", osNumber: "OS-7" }),
        asset("D2", { id: "p5", osNumber: "OS-8" }),
      ],
      [],
      from,
      to,
    );
    // Entraram: um por serial, qualquer OS; os demais contadores seguem um por serial e OS.
    expect(repeated.entraram.map((row) => row.serial).sort()).toEqual(["D1", "D2"]);
    expect(repeated.lab_total.map((row) => `${row.serial}:${row.os}`).sort()).toEqual(["D1:OS-1", "D2:OS-7", "D2:OS-8"]);
    expect(repeated.lab_total.filter((row) => row.serial === "D1")).toHaveLength(1);
    expect(repeated.lab_total.find((row) => row.serial === "D1")?.at).toBe(later);
  });
});

describe("Quarentena card", () => {
  it("shows the quarantine waiting list when given (one per serial)", () => {
    const waiting = [
      { serial: "Q1", unit: null, os: "1", technician: "Tec", status: "Aguardando quarentena", at: today },
      { serial: "q1", unit: null, os: "1", technician: "Tec", status: "Aguardando quarentena", at: yesterday },
      { serial: "Q2", unit: null, os: null, technician: "Incluído na conferência", status: "Aguardando quarentena", at: today },
    ];
    const groups = labOverview([], [balloon("Z9", { status: "finalizado", outcome: "quarentena", finishedAt: today })], from, to, waiting);
    expect(groups.destino_quarentena.map((row) => row.serial).sort()).toEqual(["Q1", "Q2"]);
  });

  it("uses the waiting list in Ainda no laboratório too, without repeating a serial", () => {
    const waiting = [
      { serial: "Q1", unit: null, os: "1", technician: "Tec", status: "Aguardando quarentena", at: today },
      { serial: "V1", unit: null, os: null, technician: "Incluído na conferência", status: "Aguardando quarentena", at: today },
    ];
    const board = [
      asset("Q9", { status: "quarentena" }), // status quarentena, mas fora da conferência
      asset("V1", { status: "vidro" }),
      asset("A1", { status: "aguardando_manutencao" }),
    ];
    const groups = labOverview(board, [], from, to, waiting);
    expect(groups.lab_quarentena.map((row) => row.serial).sort()).toEqual(["Q1", "V1"]);
    expect(groups.quarentena_aguardando.map((row) => row.serial).sort()).toEqual(["Q1", "V1"]);
    expect(groups.lab_total.map((row) => row.serial).sort()).toEqual(["A1", "Q1", "V1"]);
  });
});

describe("technicianSummaries", () => {
  const balloons = [
    balloon("C1", {}),
    balloon("C2", {}),
    balloon("C3", {}),
    balloon("C4", { status: "pendente", confirmedAt: null, technicianId: "t1", source: "transferencia", fromName: "Bia" }),
    balloon("C5", { status: "transferido", outcome: "transferido", finishedAt: today, transferredTo: "Bia" }),
    balloon("C6", { status: "finalizado", outcome: "quarentena", finishedAt: today }),
    balloon("C7", { technicianId: "t2", technician: "Bia", source: "transferencia", fromName: "Tec" }),
  ];
  const [tec, bia] = technicianSummaries(balloons, from, to) as [TechnicianSummary, TechnicianSummary];

  it("shows bench + pending = desk and the transferred counter", () => {
    expect(tec.name).toBe("Tec");
    expect([tec.bench, tec.pending, tec.desk, tec.finished, tec.transferred]).toEqual([3, 1, 4, 2, 1]);
    expect(deskLabel(tec)).toBe("3 ativos na bancada + 1 aguardando confirmação de transferência = 4 na mesa");
    expect(deskLabel(bia)).toBe("1 ativo na bancada");
  });

  it("counts a finished asset once per serial and OS", () => {
    const [only] = technicianSummaries(
      [
        balloon("E1", { id: "e1", status: "finalizado", outcome: "vidro", finishedAt: today, osNumber: "OS-1" }),
        balloon("E1", { id: "e2", status: "finalizado", outcome: "quarentena", finishedAt: today, osNumber: "OS-1" }),
        balloon("E1", { id: "e3", status: "finalizado", outcome: "quarentena", finishedAt: today, osNumber: "OS-2" }),
      ],
      from,
      to,
    ) as [TechnicianSummary];
    expect(only.finished).toBe(2);
    expect(only.rows).toHaveLength(3);
  });

  it("fills transferred to / received from", () => {
    expect(tec.rows.find((row) => row.serial === "C5")?.transferredTo).toBe("Bia");
    expect(tec.rows.find((row) => row.serial === "C4")).toMatchObject({ status: "Transferência pendente", receivedFrom: "Bia" });
    expect(bia.rows[0]?.receivedFrom).toBe("Tec");
  });
});

describe("goal and export", () => {
  it("reaches the goal when every balloon is finished", () => {
    expect(goalReached({ finished: 10, goal: 10 })).toBe(true);
    expect(goalReached({ finished: 10, goal: 11 })).toBe(false);
    expect(goalReached({ finished: 0, goal: 0 })).toBe(false);
  });

  it("exports CSV for Excel", () => {
    expect(toCsv(["Serial", "Status"], [["A1", "Em quarentena; aguardando"]])).toBe('﻿Serial;Status\r\nA1;"Em quarentena; aguardando"');
  });
});
