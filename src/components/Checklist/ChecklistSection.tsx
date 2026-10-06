import type { ChecklistBlock } from "../../domain/checklist";
import type { Results, TestResult } from "../../domain/device";
import { ChecklistItemRow } from "./ChecklistItemRow";
import styles from "./Checklist.module.css";

interface ChecklistSectionProps {
  block: ChecklistBlock;
  number: number;
  results: Results;
  onToggle: (itemId: string, result: TestResult) => void;
  disabled?: boolean;
}

export function ChecklistSection({ block, number, results, onToggle, disabled }: ChecklistSectionProps) {
  const done = block.items.filter((item) => results[item.id]).length;

  return (
    <section className={styles.block}>
      <div className={styles.header}>
        <h2>
          <span className={styles.number}>{number}</span>
          {block.title}
        </h2>
        <span className={styles.count}>
          {done}/{block.items.length}
        </span>
      </div>
      {block.items.map((item) => (
        <ChecklistItemRow key={item.id} item={item} result={results[item.id] || undefined}
          onToggle={onToggle}
          disabled={disabled}
        />
      ))}
    </section>
  );
}
