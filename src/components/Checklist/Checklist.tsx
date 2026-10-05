import { CHECKLIST } from "../../domain/checklist";
import type { Results, TestResult } from "../../domain/device";
import { ChecklistSection } from "./ChecklistSection";
import styles from "./Checklist.module.css";

interface ChecklistProps {
  results: Results;
  onToggle: (itemId: string, result: TestResult) => void;
}

export function Checklist({ results, onToggle }: ChecklistProps) {
  return (
    <div className={styles.list}>
      {CHECKLIST.map((block, i) => (
        <ChecklistSection key={block.title} block={block} number={i + 1} results={results} onToggle={onToggle} />
      ))}
    </div>
  );
}
