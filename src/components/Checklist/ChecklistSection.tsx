import type { ChecklistBlock } from "../../domain/checklist";
import type { Results, TestResult } from "../../domain/device";
import { ChecklistItemRow } from "./ChecklistItemRow";
import styles from "./Checklist.module.css";

interface ChecklistSectionProps {
  block: ChecklistBlock;
  number: number;
  results: Results;
  onToggle: (sectionId: string, result: TestResult) => void;
  onToggleItem: (sectionId: string, itemId: string) => void;
  battery?: number;
  onBatteryChange: (value: number | undefined) => void;
  disabled?: boolean;
}

const OPTIONS: { value: TestResult; label: string }[] = [
  { value: "ok", label: "OK" },
  { value: "fail", label: "Falha" },
];

export function ChecklistSection({
  block,
  number,
  results,
  onToggle,
  onToggleItem,
  battery,
  onBatteryChange,
  disabled,
}: ChecklistSectionProps) {
  const result = results[block.id] || undefined;

  return (
    <section className={[styles.block, result && styles[result]].filter(Boolean).join(" ")}>
      <div className={styles.header}>
        <h2>
          <span className={styles.number}>{number}</span>
          {block.title}
        </h2>
        <div className={styles.buttons}>
          {OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={styles[`toggle-${value}`]}
              aria-pressed={result === value}
              aria-label={`${label}: ${block.title}`}
              disabled={disabled}
              onClick={() => onToggle(block.id, value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {result === "fail" && <p className={styles.failHint}>Aponte onde ocorreu a falha (opcional):</p>}
      {block.items.map((item) => (
        <ChecklistItemRow
          key={item.id}
          item={item}
          sectionId={block.id}
          selectable={result === "fail"}
          failed={results[item.id] === "fail"}
          disabled={disabled}
          onToggleFail={onToggleItem}
          battery={item.field === "battery" ? battery : undefined}
          onBatteryChange={item.field === "battery" ? onBatteryChange : undefined}
        />
      ))}
    </section>
  );
}
