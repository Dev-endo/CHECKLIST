import styles from "./ChoiceCards.module.css";

export interface ChoiceOption<T extends string> {
  id: T;
  label: string;
  hint?: string;
  /** Opção visível mas indisponível (com o motivo no hint). */
  disabled?: boolean;
}

interface ChoiceCardsProps<T extends string> {
  name: string;
  legend: string;
  options: readonly ChoiceOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** Escolha única em cartões (retângulos em relevo). O escolhido fica todo verde. */
export function ChoiceCards<T extends string>({ name, legend, options, value, onChange, disabled = false }: ChoiceCardsProps<T>) {
  return (
    <fieldset className={styles.group} disabled={disabled}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.grid}>
        {options.map((option) => {
          const on = value === option.id;
          return (
            <label key={option.id} className={[styles.card, on ? styles.on : "", option.disabled ? styles.off : ""].join(" ")}>
              <input
                type="radio"
                className={styles.input}
                name={name}
                checked={on}
                disabled={option.disabled}
                onChange={() => onChange(option.id)}
              />
              <span className={styles.label}>
                {on && <span aria-hidden="true">✓ </span>}
                {option.label}
              </span>
              {option.hint && <span className={styles.hint}>{option.hint}</span>}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
