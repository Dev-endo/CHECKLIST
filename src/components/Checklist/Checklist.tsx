import { CHECKLIST } from "../../domain/checklist";
import type { Results, TestResult } from "../../domain/device";
import { ChecklistSection } from "./ChecklistSection";
import styles from "./Checklist.module.css";

interface ChecklistProps {
  results: Results;
  onToggle: (sectionId: string, result: TestResult) => void;
  onToggleItem: (sectionId: string, itemId: string) => void;
  disabled?: boolean;
}

export function Checklist({ results, onToggle, onToggleItem, disabled }: ChecklistProps) {
  return (
    <div className={styles.list}>
      {CHECKLIST.map((block, i) => (
        <ChecklistSection
          key={block.id}
          block={block}
          number={i + 1}
          results={results}
          onToggle={onToggle}
          onToggleItem={onToggleItem}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
