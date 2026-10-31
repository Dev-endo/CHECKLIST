import { catalogFor } from "../../domain/catalogs";
import type { ChecklistBlock, ChecklistKind } from "../../domain/checklist";
import type { Results, TestResult } from "../../domain/device";
import { ChecklistSection } from "./ChecklistSection";
import styles from "./Checklist.module.css";

interface ChecklistProps {
  /** Qual checklist mostrar; padrão: manutenção. */
  kind?: ChecklistKind;
  /** Mostra estes tópicos no lugar do catálogo do tipo (ex.: só parte dele). */
  blocks?: readonly ChecklistBlock[];
  results: Results;
  onToggle: (sectionId: string, result: TestResult) => void;
  onToggleItem: (sectionId: string, itemId: string) => void;
  battery?: number;
  onBatteryChange?: (value: number | undefined) => void;
  onConfirm: (itemId: string, checked: boolean) => void;
  disabled?: boolean;
}

export function Checklist({
  kind = "manutencao",
  blocks,
  results,
  onToggle,
  onToggleItem,
  battery,
  onBatteryChange,
  onConfirm,
  disabled,
}: ChecklistProps) {
  return (
    <div className={styles.list}>
      {(blocks ?? catalogFor(kind)).map((block, i) => (
        <ChecklistSection
          key={block.id}
          block={block}
          number={i + 1}
          results={results}
          onToggle={onToggle}
          onToggleItem={onToggleItem}
          allowPointing={kind === "manutencao" || kind === "desmontagem_tecnica"}
          battery={battery}
          onBatteryChange={onBatteryChange}
          onConfirm={onConfirm}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
