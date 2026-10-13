import { useUpdateAvailable } from "../../hooks/useUpdateAvailable";
import styles from "./UpdateBanner.module.css";

/** Faixa no topo quando há versão nova do sistema; o botão recarrega a página. */
export function UpdateBanner() {
  const available = useUpdateAvailable();
  if (!available) return null;

  return (
    <div className={styles.banner} role="status">
      <span>Houve uma atualização no sistema,</span>
      <button type="button" className={styles.reload} onClick={() => window.location.reload()}>
        recarregue a página
      </button>
    </div>
  );
}
