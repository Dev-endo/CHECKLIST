import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchAlertItems, type AlertItem } from "../../services/supabase/stockBoardService";
import { fetchAllPendingRequests, resolvePartRequest, type PendingRequest } from "../../services/supabase/stockService";
import { useToast } from "../Toast/ToastProvider";

type Decision = Parameters<typeof resolvePartRequest>[2];

interface StockRequestsValue {
  items: PendingRequest[];
  /** Solicitações novas (Reparo) e devoluções aguardando recebimento. */
  fresh: AlertItem[];
  busyId: string | null;
  decide: (item: PendingRequest, decision: Decision) => Promise<void>;
  reload: () => void;
}

const EMPTY: StockRequestsValue = { items: [], fresh: [], busyId: null, decide: async () => undefined, reload: () => undefined };

const StockRequestsContext = createContext<StockRequestsValue>(EMPTY);

const POLL_MS = 10_000;

/** Os pedidos de peça pendentes, buscados uma vez só e usados pelo aviso e pela aba Estoque. */
export function useStockRequests(): StockRequestsValue {
  return useContext(StockRequestsContext);
}

interface ProviderProps {
  client: AppSupabaseClient | null;
  /** Só o estoquista (e o admin) recebem os pedidos; sem ele, os filhos seguem sem pedidos. */
  enabled: boolean;
  children: ReactNode;
}

export function StockRequestsProvider({ client, enabled, children }: ProviderProps) {
  const toast = useToast();
  const [items, setItems] = useState<PendingRequest[]>([]);
  const [fresh, setFresh] = useState<AlertItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!enabled || !client) return;
    fetchAllPendingRequests(client)
      .then(setItems)
      .catch(() => undefined);
    fetchAlertItems(client)
      .then(setFresh)
      .catch(() => undefined);
  }, [client, enabled]);

  useEffect(() => {
    if (!enabled || !client) {
      setItems([]);
      setFresh([]);
      return;
    }
    reload();
    const timer = setInterval(reload, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, client, reload]);

  // Também avisa pela aba do navegador quando a janela está em segundo plano.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    const total = items.length + fresh.length;
    document.title = total ? `(${total}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [items.length, fresh.length]);

  const decide = useCallback(
    async (item: PendingRequest, decision: Decision) => {
      if (!client) return;
      setBusyId(item.id);
      try {
        const result = await resolvePartRequest(client, item.id, decision);
        toast(result === "duplicate" ? `${item.part} já está alocada nessa OS.` : "Pedido decidido");
      } catch {
        toast("Não foi possível decidir o pedido. Tente de novo.");
      } finally {
        setBusyId(null);
        reload();
      }
    },
    [client, reload, toast],
  );

  const value = useMemo(() => ({ items, fresh, busyId, decide, reload }), [items, fresh, busyId, decide, reload]);
  return <StockRequestsContext.Provider value={value}>{children}</StockRequestsContext.Provider>;
}
