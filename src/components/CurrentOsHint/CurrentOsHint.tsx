import { useEffect, useState } from "react";
import appStyles from "../../App.module.css";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchAssetOrders, type ServiceOrder } from "../../services/supabase/serviceOrderService";

interface CurrentOsHintProps {
  client: AppSupabaseClient;
  /** Serial bipado no checklist; vazio não mostra nada. */
  serial: string;
}

const DEBOUNCE_MS = 400;

/** A OS atual do ativo: a mesma OS vale em todas as etapas, até o ativo voltar ao laboratório e ganhar outra. */
export function CurrentOsHint({ client, serial }: CurrentOsHintProps) {
  const key = serial.trim();
  const [orders, setOrders] = useState<ServiceOrder[] | null>(null);

  useEffect(() => {
    setOrders(null);
    if (!key) return;
    let active = true;
    const timer = setTimeout(() => {
      fetchAssetOrders(client, key)
        .then((found) => active && setOrders(found))
        .catch(() => undefined);
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, key]);

  if (!key || !orders) return null;
  const current = orders[orders.length - 1];
  if (!current) return <p className={appStyles.hint}>Nenhuma OS registrada para este ativo. A OS é registrada pelo desmontador, na aba Ordens de serviço.</p>;
  return (
    <p className={appStyles.hint}>
      OS atual: {current.osNumber} ({orders.length}ª OS deste ativo)
    </p>
  );
}
