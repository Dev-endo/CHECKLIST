import { formatDateTime } from "../utils/format";
import { computeStats, TOTAL_TESTS, type DeviceDraft } from "./device";

/** Texto do laudo para colar em sistemas externos. */
export function buildReport(draft: DeviceDraft, date = new Date()): string {
  const { done, fails, pending } = computeStats(draft.r);
  const result = fails.length ? "REPROVADO" : pending.length ? "INCOMPLETO" : "LIBERADO";
  const lines = [
    `Laudo de testes iPhone · ${formatDateTime(date)}`,
    `Modelo: ${draft.modelo || "-"} · IMEI/série: ${draft.serial || "-"} · Técnico: ${draft.tec || "-"}`,
    `Resultado: ${result} (${done}/${TOTAL_TESTS} testados)`,
  ];
  if (fails.length) lines.push("Falhas: " + fails.map((item) => item.title).join("; "));
  else if (pending.length) lines.push("Não testados: " + pending.map((item) => item.title).join("; "));
  return lines.join("\n");
}
