import { useState } from "react";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { requestPart } from "../../services/supabase/stockService";
import { Button } from "../Button/Button";
import { useToast } from "../Toast/ToastProvider";
import { RequestPartDialog } from "./RequestPartDialog";

interface RequestPartButtonProps {
  client: AppSupabaseClient;
  serial: string;
  kind: "nova" | "teste";
  label: string;
  disabled?: boolean;
  /** Chamado depois que o pedido foi enviado (ex.: recarregar a lista de pedidos). */
  onSent?: () => void;
}

/** Botão que abre o balão de pedido de peça e envia o pedido ao estoque. */
export function RequestPartButton({ client, serial, kind, label, disabled = false, onSent }: RequestPartButtonProps) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const send = async (part: string) => {
    setBusy(true);
    try {
      const result = await requestPart(client, { serial, part, kind });
      if (result === "no_os") toast("Este aparelho ainda não tem OS do estoque. Fale com o estoquista.");
      else if (result === "duplicate") toast(`${part} já foi solicitada e espera o estoquista.`);
      else {
        toast("Pedido enviado ao estoquista");
        setOpen(false);
        onSent?.();
      }
    } catch {
      toast("Não foi possível enviar o pedido. Tente de novo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="small" disabled={disabled || !serial.trim()} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <RequestPartDialog open={open} busy={busy} kind={kind} onCancel={() => setOpen(false)} onConfirm={(part) => void send(part)} />
    </>
  );
}
