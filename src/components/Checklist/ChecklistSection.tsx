import type { ChecklistBlock } from "../../domain/checklist";
import { isConfirmed, type Results, type TestResult } from "../../domain/device";
import { ChecklistItemRow } from "./ChecklistItemRow";
import styles from "./Checklist.module.css";

interface ChecklistSectionProps {
  block: ChecklistBlock;
  number: number;
  results: Results;
  onToggle: (sectionId: string, result: TestResult) => void;
  onToggleItem: (sectionId: string, itemId: string) => void;
  /** Em "Falha", deixa apontar qual item falhou (só na manutenção). */
  allowPointing?: boolean;
  battery?: number;
  onBatteryChange?: (value: number | undefined) => void;
  onConfirm: (itemId: string, checked: boolean) => void;
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
  allowPointing = true,
  battery,
  onBatteryChange,
  onConfirm,
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
      </div>
      {result === "fail" && allowPointing && <p className={styles.failHint}>Aponte onde ocorreu a falha (opcional):</p>}
      {block.items.map((item) => (
        <ChecklistItemRow
          key={item.id}
          item={item}
          sectionId={block.id}
          selectable={result === "fail" && allowPointing}
          failed={results[item.id] === "fail"}
          disabled={disabled}
          onToggleFail={onToggleItem}
          battery={item.field === "battery" ? battery : undefined}
          onBatteryChange={item.field === "battery" ? onBatteryChange : undefined}
          confirmed={item.field === "confirm" ? isConfirmed(results, item.id) : undefined}
          onConfirmChange={item.field === "confirm" ? (checked) => onConfirm(item.id, checked) : undefined}
        />
      ))}
      {!block.confirmOnly && (
      <div className={styles.footer}>
        <span className={styles.footerLabel}>Resultado do tópico</span>
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
      )}
    </section>
  );
}
