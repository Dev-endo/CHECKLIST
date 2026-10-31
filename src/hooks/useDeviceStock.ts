import { useCallback, useEffect, useState } from "react";
import type { AppSupabaseClient } from "../services/supabase/client";
import { fetchAssetOrders } from "../services/supabase/serviceOrderService";
import {
  fetchPendingRequests,
  fetchSerialAllocations,
  fetchSerialLoans,
  type PartAllocation,
  type PartLoan,
  type PartRequest,
} from "../services/supabase/stockService";

/** O que o estoque tem com o aparelho na OS atual: peças com o técnico, peças de teste e pedidos esperando o estoquista. */
export interface DeviceStock {
  /** Peças que o estoquista alocou (já liberadas no aparelho) e ainda estão com o técnico. */
  open: PartAllocation[];
  loans: PartLoan[];
  requests: PartRequest[];
}

/**
 * Busca o estoque do aparelho (pelo serial) na OS mais recente. `debounceMs` espera o serial parar de mudar;
 * `pollMs` atualiza sozinho (o estoquista pode emprestar ou liberar uma peça a qualquer momento).
 * `stock` é null enquanto carrega; `failed` indica que não foi possível consultar.
 */
export function useDeviceStock(
  client: AppSupabaseClient | undefined,
  serial: string,
  enabled: boolean,
  { debounceMs = 0, pollMs = 0 }: { debounceMs?: number; pollMs?: number } = {},
) {
  const key = serial.trim();
  const [stock, setStock] = useState<DeviceStock | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const refresh = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !client || !key) {
      setStock(null);
      setFailed(false);
      return;
    }
    let active = true;
    const load = () =>
      Promise.all([
        fetchAssetOrders(client, key),
        fetchSerialAllocations(client, key),
        fetchPendingRequests(client, key),
        fetchSerialLoans(client, key),
      ])
        .then(([orders, allocations, requests, loans]) => {
          if (!active) return;
          const current = orders[orders.length - 1];
          const mine = current ? allocations.filter((a) => a.osId === current.id).reverse() : [];
          setFailed(false);
          setStock({
            open: mine.filter((a) => a.status === "liberada"),
            requests: current ? requests.filter((r) => r.osId === current.id) : [],
            loans: current ? loans.filter((l) => l.osId === current.id && l.status === "emprestada") : [],
          });
        })
        .catch(() => {
          if (!active) return;
          setStock(null);
          setFailed(true);
        });
    const first = setTimeout(() => void load(), debounceMs);
    const timer = pollMs ? setInterval(() => void load(), pollMs) : undefined;
    return () => {
      active = false;
      clearTimeout(first);
      if (timer) clearInterval(timer);
    };
  }, [enabled, client, key, reloads, debounceMs, pollMs]);

  return { stock, failed, refresh };
}
