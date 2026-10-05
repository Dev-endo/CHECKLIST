import { memo } from "react";
import type { ChecklistItem } from "../../domain/checklist";
import type { TestResult } from "../../domain/device";
import styles from "./Checklist.module.css";

interface ChecklistItemRowProps {
  item: ChecklistItem;
  result?: TestResult;
  onToggle: (itemId: string, result: TestResult) => void;
}

const OPTIONS: { value: TestResult; label: string }[] = [
  { value: "ok", label: "OK" },
  { value: "fail", label: "Falha" },
];

export const ChecklistItemRow = memo(function ChecklistItemRow({ item, result, onToggle }: ChecklistItemRowProps) {
  return (
    <div className={[styles.item, result && styles[result]].filter(Boolean).join(" ")}>
      <div>
        <h3>{item.title}</h3>
        <p>
          {item.details}
          {item.details && item.failure && " "}
          {item.failure && (
            <>
              <b>Falha:</b> {item.failure}
            </>
          )}
        </p>
      </div>
      <div className={styles.buttons}>
        {OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={styles[`toggle-${value}`]}
            aria-pressed={result === value}
            onClick={() => onToggle(item.id, value)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
});
