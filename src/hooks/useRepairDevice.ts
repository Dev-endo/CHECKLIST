import { useCallback, useEffect, useState } from "react";
import type { AppSupabaseClient } from "../services/supabase/client";
import { lookupAsset, type Asset } from "../services/supabase/assetsService";
import { canRedisassemble, fetchRequests, fetchStage, type RepairStage, type StockRequest } from "../services/supabase/repairService";
import { fetchAssetOrders, type ServiceOrder } from "../services/supabase/serviceOrderService";
import { fetchReturns, type StockReturn } from "../services/supabase/stockBoardService";

export interface RepairStages {
  disassembly: RepairStage | null;
  evaluation: RepairStage | null;
  maintenance: RepairStage | null;
}

const NO_STAGES: RepairStages = { disassembly: null, evaluation: null, maintenance: null };
const POLL_MS = 10_000;

/**
 * Tudo o que as telas do Reparo mostram de um aparelho (pelo serial): ativo, OS atual, as três fases,
 * solicitações de peça e devoluções. Atualiza sozinho: o estoque responde a qualquer hora.
 */
export function useRepairDevice(client: AppSupabaseClient, serial: string, onError: () => void) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [order, setOrder] = useState<ServiceOrder | null>(null);
  const [stages, setStages] = useState<RepairStages>(NO_STAGES);
  const [requests, setRequests] = useState<StockRequest[]>([]);
  const [returns, setReturns] = useState<StockReturn[]>([]);
  const [canRedo, setCanRedo] = useState(false);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!serial) {
        setAsset(null);
        setOrder(null);
        setStages(NO_STAGES);
        setRequests([]);
        setReturns([]);
        setCanRedo(false);
        return;
      }
      try {
        const [found, orders] = await Promise.all([lookupAsset(client, serial), fetchAssetOrders(client, serial)]);
        const current = orders[orders.length - 1] ?? null;
        // A rodada em andamento é a da desmontagem mais recente; avaliação e manutenção são da mesma rodada.
        const latest = current ? await fetchStage(client, current.id, "desmontagem") : null;
        const [evaluation, maintenance, currentRequests, currentReturns, redo] = current
          ? await Promise.all([
              fetchStage(client, current.id, "avaliacao", latest?.round),
              fetchStage(client, current.id, "manutencao", latest?.round),
              fetchRequests(client, current.id),
              fetchReturns(client, current.id),
              latest ? canRedisassemble(client, serial).catch(() => false) : Promise.resolve(false),
            ])
          : [null, null, [], [], false];
        const disassembly = latest;
        if (!active) return;
        setAsset(found);
        setOrder(current);
        setStages({ disassembly, evaluation, maintenance });
        setRequests(currentRequests);
        setReturns(currentReturns);
        setCanRedo(redo);
      } catch {
        if (active) onError();
      }
    };
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
    // onError muda a cada render nas telas; só o serial e o recarregar disparam nova consulta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, serial, reloads]);

  return { asset, order, stages, requests, returns, canRedo, reload };
}
