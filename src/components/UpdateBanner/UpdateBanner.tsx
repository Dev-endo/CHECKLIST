import { useUpdateAvailable } from "../../hooks/useUpdateAvailable";
import styles from "./UpdateBanner.module.css";

/** Aviso no meio da tela quando há versão nova do sistema; o botão recarrega a página. */
export function UpdateBanner() {
  const available = useUpdateAvailable();
  if (!available) return null;

  return (
    <div className={styles.overlay}>
      <div className={styles.card} role="alertdialog" aria-modal="true" aria-labelledby="update-message">
        <p id="update-message" className={styles.message}>
          Houve uma atualização no sistema,
        </p>
        <button type="button" className={styles.reload} onClick={() => window.location.reload()}>
          recarregue a página
        </button>
      </div>
    </div>
  );
}
