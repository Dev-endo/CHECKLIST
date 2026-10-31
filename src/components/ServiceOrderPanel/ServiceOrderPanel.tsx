import { useEffect, useState } from "react";
import { splitAssetId } from "../../domain/device";
import { lookupAsset, type Asset } from "../../services/supabase/assetsService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  correctServiceOrder,
  fetchAssetOrders,
  type ServiceOrder,
} from "../../services/supabase/serviceOrderService";
import { formatDateTime } from "../../utils/format";
import { Button } from "../Button/Button";
import { OsMapDialog } from "../OsMapDialog/OsMapDialog";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import { useToast } from "../Toast/ToastProvider";
import styles from "./ServiceOrderPanel.module.css";

interface ServiceOrderPanelProps {
  client: AppSupabaseClient;
  /** Só o admin corrige o número de uma OS registrada errada. */
  canCorrect: boolean;
}

const LOOKUP_DEBOUNCE_MS = 250;

/**
 * Consulta as OS de um ativo (a OS é registrada pelo desmontador, no campo da desmontagem). O admin corrige o
 * número de uma OS registrada errada.
 */
export function ServiceOrderPanel({ client, canCorrect }: ServiceOrderPanelProps) {
  const toast = useToast();
  const [serial, setSerial] = useState("");
  const [asset, setAsset] = useState<Asset | null | "missing">(null);
  const [orders, setOrders] = useState<ServiceOrder[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; number: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const key = serial.trim();

  useEffect(() => {
    if (!key) {
      setAsset(null);
      setOrders(null);
      setFailed(false);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      setFailed(false);
      lookupAsset(client, key)
        .then((found) => active && setAsset(found ?? "missing"))
        .catch(() => active && setAsset(null));
      fetchAssetOrders(client, key)
        .then((found) => active && setOrders(found))
        .catch(() => active && setFailed(true));
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, key, reloads]);

  const saveCorrection = async () => {
    if (!editing || !editing.number.trim()) return;
    setSaving(true);
    try {
      const result = await correctServiceOrder(client, editing.id, editing.number);
      if (result === "duplicate") {
        toast("Esse número de OS já existe em outra OS.");
      } else {
        toast("OS corrigida");
        setEditing(null);
        setReloads((n) => n + 1);
      }
    } catch {
      toast("Não foi possível corrigir a OS. Tente de novo.");
    } finally {
      setSaving(false);
    }
  };

  const found = asset && asset !== "missing" ? asset : null;
  const parts = found ? splitAssetId(found.assetShortId) : null;

  return (
    <section className={recordStyles.panel} aria-label="Ordens de serviço">
      <div className={recordStyles.header}>
        <h2>Ordens de serviço</h2>
      </div>
      <div className={styles.form}>
        <label className={styles.field}>
          Serial
          <input
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="Bipe o serial para ver as OS do ativo"
            autoComplete="off"
            autoFocus
          />
        </label>
        <label className={styles.field}>
          Modelo
          <input value={parts ? parts.model : ""} readOnly disabled placeholder="—" />
        </label>
      </div>
      {asset === "missing" && key && <p className={styles.hint}>Serial não encontrado na lista de ativos.</p>}

      {key && (
        <>
          <div className={styles.summary}>
            <span>
              {failed
                ? "Não foi possível carregar as OS deste ativo."
                : orders
                  ? orders.length === 0
                    ? "Este ativo ainda não tem nenhuma OS."
                    : `Este ativo já teve ${orders.length} OS.`
                  : "Carregando OS…"}
            </span>
          </div>
          {orders && orders.length > 0 && (
            <ul className={styles.list}>
              {[...orders].reverse().map((order, index) => (
                <li key={order.id} className={styles.row}>
                  {editing?.id === order.id ? (
                    <form
                      className={styles.edit}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveCorrection();
                      }}
                    >
                      <input
                        value={editing.number}
                        onChange={(e) => setEditing({ id: order.id, number: e.target.value })}
                        maxLength={40}
                        autoComplete="off"
                        aria-label="Número correto da OS"
                        disabled={saving}
                        autoFocus
                      />
                      <Button type="submit" variant="small" disabled={saving || !editing.number.trim()}>
                        Salvar
                      </Button>
                      <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
                        Cancelar
                      </Button>
                    </form>
                  ) : (
                    <>
                      <button type="button" className={styles.item} onClick={() => setOpenId(order.id)}>
                        <span className={styles.number}>OS {order.osNumber}</span>
                        <span className={styles.meta}>
                          {orders.length - index}ª OS · {formatDateTime(order.createdAt)} · {order.registeredBy}
                        </span>
                        <span className={styles.open}>Ver mapa</span>
                      </button>
                      {canCorrect && (
                        <Button variant="small" onClick={() => setEditing({ id: order.id, number: order.osNumber })}>
                          Corrigir
                        </Button>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <OsMapDialog client={client} osId={openId} onClose={() => setOpenId(null)} />
    </section>
  );
}
