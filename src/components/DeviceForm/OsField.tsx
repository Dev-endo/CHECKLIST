import { useEffect, useState } from "react";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchAssetOrders, registerServiceOrder, type ServiceOrder } from "../../services/supabase/serviceOrderService";
import { lookupAsset } from "../../services/supabase/assetsService";
import { Button } from "../Button/Button";
import { useToast } from "../Toast/ToastProvider";
import styles from "./OsField.module.css";

interface OsFieldProps {
  client: AppSupabaseClient;
  /** Serial bipado no checklist; vazio desabilita o campo. */
  serial: string;
  disabled?: boolean;
  /** Chamado depois de registrar uma OS, para a tela recarregar o que depende dela. */
  onRegistered?: () => void;
}

const DEBOUNCE_MS = 400;

/**
 * Campo da OS no checklist de desmontagem: o desmontador digita a OS do ativo e registra. Cada passagem do
 * aparelho pelo laboratório tem uma OS nova (o serial pode se repetir, a OS não); a mais recente é a atual.
 */
export function OsField({ client, serial, disabled = false, onRegistered }: OsFieldProps) {
  const toast = useToast();
  const key = serial.trim();
  const [orders, setOrders] = useState<ServiceOrder[] | null>(null);
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    setOrders(null);
    setTouched(false);
    if (!key) {
      setValue("");
      return;
    }
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
  }, [client, key, reloads]);

  const current = orders && orders.length ? orders[orders.length - 1] : undefined;
  // Sem digitar nada, o campo mostra a OS atual do ativo.
  useEffect(() => {
    if (!touched) setValue(current?.osNumber ?? "");
  }, [current?.osNumber, touched]);

  const number = value.trim();
  const isNew = Boolean(number) && number.toLowerCase() !== (current?.osNumber ?? "").toLowerCase();

  const register = async () => {
    if (!key || !isNew || saving) return;
    if (current && !window.confirm(`Este ativo já tem a OS ${current.osNumber}. Registrar a OS ${number} como uma nova passagem pelo laboratório?`)) return;
    setSaving(true);
    try {
      const asset = await lookupAsset(client, key).catch(() => null);
      const result = await registerServiceOrder(client, { serial: key, osNumber: number, unit: asset?.assetShortId ?? null });
      if (result === "duplicate") {
        toast("Essa OS já foi registrada. Confira o número.");
      } else {
        toast(`OS ${number} registrada`);
        setTouched(false);
        setReloads((n) => n + 1);
        onRegistered?.();
      }
    } catch {
      toast("Não foi possível registrar a OS. Tente de novo.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.field}>
      <label className={styles.label}>
        Nº da OS
        <span className={styles.row}>
          <input
            value={value}
            placeholder="Digite a OS do ativo"
            maxLength={40}
            autoComplete="off"
            disabled={disabled || saving || !key}
            onChange={(e) => {
              setValue(e.target.value);
              setTouched(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void register();
              }
            }}
          />
          <Button variant="small" disabled={disabled || saving || !isNew} onClick={() => void register()}>
            {saving ? "…" : "Registrar"}
          </Button>
        </span>
      </label>
      {key && orders && (
        <span className={styles.hint}>
          {current ? `OS atual deste ativo (${orders.length}ª OS). Para uma nova passagem, digite a nova OS e registre.` : "Sem OS: digite a OS do ativo e registre."}
        </span>
      )}
    </div>
  );
}
