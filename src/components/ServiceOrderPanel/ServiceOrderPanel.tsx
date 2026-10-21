import { useEffect, useRef, useState, type FormEvent } from "react";
import { splitAssetId } from "../../domain/device";
import { lookupAsset, type Asset } from "../../services/supabase/assetsService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  fetchAssetOrders,
  registerServiceOrder,
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
}

const LOOKUP_DEBOUNCE_MS = 250;

/** Registra a OS de um ativo: bipa o serial, confere modelo e unit id, escreve o número da OS e confirma. */
export function ServiceOrderPanel({ client }: ServiceOrderPanelProps) {
  const toast = useToast();
  const serialInput = useRef<HTMLInputElement>(null);
  const [serial, setSerial] = useState("");
  const [osNumber, setOsNumber] = useState("");
  const [asset, setAsset] = useState<Asset | null | "missing">(null);
  const [orders, setOrders] = useState<ServiceOrder[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const key = serial.trim();

  // Ao bipar o serial: busca modelo e unit id na planilha de ativos e as OS que o ativo já teve.
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

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    const number = osNumber.trim();
    if (!key || !number) return;
    setSaving(true);
    try {
      const result = await registerServiceOrder(client, {
        serial: key,
        osNumber: number,
        unit: asset && asset !== "missing" ? asset.assetShortId : null,
      });
      if (result === "duplicate") {
        toast("Essa OS já foi registrada. Confira o número.");
      } else {
        toast(`OS ${number} registrada`);
        setOsNumber("");
        setReloads((n) => n + 1);
      }
    } catch {
      toast("Não foi possível registrar a OS. Tente de novo.");
    } finally {
      setSaving(false);
    }
  };

  const next = () => {
    setSerial("");
    setOsNumber("");
    serialInput.current?.focus();
  };

  const found = asset && asset !== "missing" ? asset : null;
  const parts = found ? splitAssetId(found.assetShortId) : null;

  return (
    <section className={recordStyles.panel} aria-label="Ordens de serviço">
      <div className={recordStyles.header}>
        <h2>Registrar OS</h2>
      </div>
      <form className={styles.form} onSubmit={(e) => void confirm(e)}>
        <label className={styles.field}>
          Serial
          <input
            ref={serialInput}
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="Bipe o serial"
            autoComplete="off"
            autoFocus
            disabled={saving}
          />
        </label>
        <label className={styles.field}>
          Modelo
          <input value={parts ? parts.model : ""} readOnly disabled placeholder="—" />
        </label>
        <label className={styles.field}>
          Unit ID
          <input value={parts ? parts.code || found?.assetShortId : ""} readOnly disabled placeholder="—" />
        </label>
        <label className={styles.field}>
          Número da OS
          <input
            value={osNumber}
            onChange={(e) => setOsNumber(e.target.value)}
            placeholder="Escreva o número da OS"
            autoComplete="off"
            maxLength={40}
            disabled={saving || !key}
          />
        </label>
        <Button type="submit" disabled={saving || !key || !osNumber.trim()}>
          {saving ? "Registrando…" : "Confirmar"}
        </Button>
      </form>
      {asset === "missing" && key && (
        <p className={styles.hint}>Serial não encontrado na lista de ativos. A OS será registrada só com o serial.</p>
      )}

      {key && (
        <>
          <div className={styles.summary}>
            <span>
              {failed
                ? "Não foi possível carregar as OS deste ativo."
                : orders
                  ? orders.length === 0
                    ? "Este ativo ainda não tem nenhuma OS."
                    : `Este ativo já teve ${orders.length} ${orders.length === 1 ? "OS" : "OS"}.`
                  : "Carregando OS…"}
            </span>
            <Button variant="small" onClick={next}>
              Próximo ativo
            </Button>
          </div>
          {orders && orders.length > 0 && (
            <ul className={styles.list}>
              {[...orders].reverse().map((order, index) => (
                <li key={order.id}>
                  <button type="button" className={styles.item} onClick={() => setOpenId(order.id)}>
                    <span className={styles.number}>OS {order.osNumber}</span>
                    <span className={styles.meta}>
                      {orders.length - index}ª OS · {formatDateTime(order.createdAt)} · {order.registeredBy}
                    </span>
                    <span className={styles.open}>Ver mapa</span>
                  </button>
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
