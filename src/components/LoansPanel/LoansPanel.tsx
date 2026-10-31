import { useCallback, useEffect, useState } from "react";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchOpenLoans, returnLoan, type OpenLoan } from "../../services/supabase/stockService";
import { formatDateTime } from "../../utils/format";
import { Button } from "../Button/Button";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import serviceStyles from "../ServiceOrderPanel/ServiceOrderPanel.module.css";
import { useToast } from "../Toast/ToastProvider";
import styles from "../StockPanel/StockPanel.module.css";

interface LoansPanelProps {
  client: AppSupabaseClient;
}

/** Peças emprestadas para teste e com quem estão. Toda peça de teste tem que voltar ao estoque. */
export function LoansPanel({ client }: LoansPanelProps) {
  const toast = useToast();
  const [loans, setLoans] = useState<OpenLoan[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchOpenLoans(client)
      .then((found) => {
        setLoans(found);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const giveBack = async (loan: OpenLoan) => {
    if (!window.confirm(`Confirmar que a peça ${loan.part} voltou ao estoque?`)) return;
    setBusyId(loan.id);
    try {
      await returnLoan(client, loan.id);
      toast("Devolução registrada");
    } catch {
      toast("Não foi possível registrar a devolução. Tente de novo.");
    } finally {
      setBusyId(null);
      load();
    }
  };

  return (
    <section className={recordStyles.panel} aria-label="Peças emprestadas">
      <div className={recordStyles.header}>
        <h2>Peças emprestadas para teste</h2>
        <Button variant="small" onClick={load}>
          Atualizar
        </Button>
      </div>
      <div className={serviceStyles.summary}>
        <span>
          {failed
            ? "Não foi possível carregar as peças emprestadas."
            : loans
              ? loans.length === 0
                ? "Nenhuma peça emprestada no momento."
                : `${loans.length} ${loans.length === 1 ? "peça emprestada" : "peças emprestadas"}.`
              : "Carregando…"}
        </span>
      </div>
      {loans && loans.length > 0 && (
        <ul className={serviceStyles.list}>
          {loans.map((loan) => (
            <li key={loan.id} className={styles.allocation}>
              <span className={serviceStyles.number}>{loan.part}</span>
              <span className={serviceStyles.meta}>
                {loan.model ?? "—"} · OS {loan.osNumber} · com {loan.borrower} desde {formatDateTime(loan.since)}
              </span>
              <Button variant="small" disabled={busyId === loan.id} onClick={() => void giveBack(loan)}>
                Registrar devolução
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
