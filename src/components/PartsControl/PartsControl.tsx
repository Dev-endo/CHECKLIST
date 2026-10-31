import { useState } from "react";
import { useDeviceStock } from "../../hooks/useDeviceStock";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { requestPart, type PartAllocation, type PartLoan } from "../../services/supabase/stockService";
import { Button } from "../Button/Button";
import { RequestPartButton } from "../RequestPartDialog/RequestPartButton";
import { useToast } from "../Toast/ToastProvider";
import styles from "./PartsControl.module.css";

interface PartsControlProps {
  client: AppSupabaseClient;
  serial: string;
  /** Desmontagem técnica: pede peça para teste e para reparo; não troca peça nem libera uso. */
  technical?: boolean;
  disabled?: boolean;
}

const POLL_MS = 15_000;

/**
 * Peças do aparelho, na tela do checklist (antes de concluir): trocar uma peça alocada, solicitar nova peça
 * ou peça para teste, e o que fazer com a peça de teste que o estoquista emprestou.
 */
export function PartsControl({ client, serial, technical = false, disabled = false }: PartsControlProps) {
  const toast = useToast();
  const { stock, refresh } = useDeviceStock(client, serial, true, { debounceMs: 400, pollMs: POLL_MS });
  const [busy, setBusy] = useState(false);

  const key = serial.trim();
  if (!key) return null;

  const ask = async (part: string, kind: "troca" | "uso" | "devolucao", link: { allocationId?: string; loanId?: string }, done: string) => {
    setBusy(true);
    try {
      const result = await requestPart(client, { serial: key, part, kind, ...link });
      toast(result === "ok" ? done : "Esse pedido já foi enviado.");
      refresh();
    } catch {
      toast("Não foi possível enviar o pedido. Tente de novo.");
    } finally {
      setBusy(false);
    }
  };

  const swapping = new Set((stock?.requests ?? []).flatMap((r) => (r.kind === "troca" && r.allocationId ? [r.allocationId] : [])));
  const waiting = (loan: PartLoan) => (stock?.requests ?? []).find((r) => r.loanId === loan.id);

  const swapButton = (part: PartAllocation) =>
    swapping.has(part.id) ? (
      <span className={styles.waiting}>Troca solicitada: aguardando o estoquista</span>
    ) : (
      <Button variant="small" disabled={disabled || busy} onClick={() => void ask(part.part, "troca", { allocationId: part.id }, "Troca solicitada ao estoquista")}>
        Trocar peça
      </Button>
    );

  const testButton = (
    <RequestPartButton client={client} serial={key} kind="teste" label="Solicitar peça para teste" disabled={disabled} onSent={refresh} />
  );

  return (
    <section className={styles.box} aria-label="Peças do aparelho">
      <h2 className={styles.title}>Peças do aparelho</h2>

      {stock?.open.map((part) => (
        <div key={part.id} className={styles.row}>
          <span className={styles.name}>{part.part}</span>
          <span className={styles.state}>Alocada pelo estoque</span>
          {!technical && swapButton(part)}
        </div>
      ))}

      {stock?.loans.map((loan) => {
        const pending = waiting(loan);
        return (
          <div key={loan.id} className={[styles.row, styles.loan].join(" ")}>
            <span className={styles.name}>{loan.part}</span>
            <span className={styles.state}>Peça de teste alocada: precisa de liberação do estoquista ou devolução</span>
            {pending ? (
              <span className={styles.waiting}>
                {pending.kind === "uso" ? "Liberação pedida" : "Devolução informada"}: aguardando o estoquista
              </span>
            ) : (
              <>
                {!technical && (
                  <Button variant="small" disabled={disabled || busy} onClick={() => void ask(loan.part, "uso", { loanId: loan.id }, "Liberação pedida ao estoquista")}>
                    Solicitar liberação
                  </Button>
                )}
                <Button variant="small" disabled={disabled || busy} onClick={() => void ask(loan.part, "devolucao", { loanId: loan.id }, "Devolução informada ao estoquista")}>
                  Devolver ao estoque
                </Button>
              </>
            )}
          </div>
        );
      })}

      {stock?.requests
        .filter((r) => r.kind === "nova" || r.kind === "teste")
        .map((r) => (
          <p key={r.id} className={styles.waiting}>
            {r.kind === "teste" ? "Peça para teste" : technical ? "Peça para reparo" : "Nova peça"} solicitada ({r.part}): aguardando o estoquista.
          </p>
        ))}

      <div className={styles.actions}>
        <RequestPartButton
          client={client}
          serial={key}
          kind="nova"
          label={technical ? "Solicitar peça para reparo" : "Solicitar nova peça"}
          disabled={disabled}
          onSent={refresh}
        />
        {testButton}
      </div>
    </section>
  );
}
