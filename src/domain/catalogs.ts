import { ASSEMBLY_CHECKLIST } from "./assemblyChecklist";
import { CHECKLIST, isDisassembly, type ChecklistBlock, type ChecklistKind } from "./checklist";
import { DISASSEMBLY_CHECKLIST, TECHNICAL_DISASSEMBLY_CHECKLIST } from "./disassemblyChecklist";

/** Tópicos de cada tipo de checklist. */
export function catalogFor(kind: ChecklistKind): readonly ChecklistBlock[] {
  if (kind === "desmontagem_tecnica") return TECHNICAL_DISASSEMBLY_CHECKLIST;
  if (isDisassembly(kind)) return DISASSEMBLY_CHECKLIST;
  return kind === "montagem" ? ASSEMBLY_CHECKLIST : CHECKLIST;
}
