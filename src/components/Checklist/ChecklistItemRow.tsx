import { memo } from "react";
import { BATTERY_TARGET } from "../../domain/device";
import type { ChecklistItem } from "../../domain/checklist";
import styles from "./Checklist.module.css";

interface ChecklistItemRowProps {
  item: ChecklistItem;
  sectionId: string;
  /** Tópico em "Falha": o item pode ser apontado como o lugar da falha. */
  selectable: boolean;
  failed: boolean;
  disabled?: boolean;
  onToggleFail: (sectionId: string, itemId: string) => void;
  /** Só no item com campo de bateria. */
  battery?: number;
  onBatteryChange?: (value: number | undefined) => void;
}

/** Instrução do teste. O resultado é do tópico; só a falha pode ser apontada por item. */
export const ChecklistItemRow = memo(function ChecklistItemRow({
  item,
  sectionId,
  selectable,
  failed,
  disabled,
  onToggleFail,
  battery,
  onBatteryChange,
}: ChecklistItemRowProps) {
  const hasBattery = item.field === "battery" && onBatteryChange !== undefined;
  return (
    <div className={[styles.item, (selectable || hasBattery) && styles.selectable, failed && styles.itemFailed].filter(Boolean).join(" ")}>
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
      {hasBattery && (
        <label className={styles.battery}>
          <input
            type="checkbox"
            checked={battery === BATTERY_TARGET}
            disabled={disabled}
            onChange={(e) => onBatteryChange(e.target.checked ? BATTERY_TARGET : undefined)}
          />
          <span>{BATTERY_TARGET}% de bateria</span>
        </label>
      )}
      {selectable && (
        <button
          type="button"
          className={styles.itemFail}
          aria-pressed={failed}
          aria-label={`Falhou em: ${item.title}`}
          disabled={disabled}
          onClick={() => onToggleFail(sectionId, item.id)}
        >
          Falhou aqui
        </button>
      )}
    </div>
  );
});
