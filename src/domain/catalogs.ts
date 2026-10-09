import { ASSEMBLY_CHECKLIST } from "./assemblyChecklist";
import { CHECKLIST, type ChecklistBlock, type ChecklistKind } from "./checklist";

/** Tópicos de cada tipo de checklist. */
export function catalogFor(kind: ChecklistKind): readonly ChecklistBlock[] {
  return kind === "montagem" ? ASSEMBLY_CHECKLIST : CHECKLIST;
}
