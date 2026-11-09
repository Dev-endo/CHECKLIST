import { useEffect, useState } from "react";
import { describeRepairError } from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchCleaning, setMaintenanceCleaning } from "../../services/supabase/repairService";
import { useToast } from "../Toast/ToastProvider";
import stage1Styles from "../RepairStage1/RepairStage1.module.css";

interface CleaningToggleProps {
  client: AppSupabaseClient;
  stageId: string;
  disabled?: boolean;
}

/** Marca que foi feita a limpeza: conta como 1 manutenção, além das peças trocadas (que continuam podendo ser pedidas). */
export function CleaningToggle({ client, stageId, disabled = false }: CleaningToggleProps) {
  const toast = useToast();
  const [cleaning, setCleaning] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setCleaning(false);
    fetchCleaning(client, stageId).then((value) => {
      if (!active) return;
      setCleaning(value);
    });
    return () => {
      active = false;
    };
  }, [client, stageId]);

  const toggle = async (value: boolean) => {
    setBusy(true);
    try {
      await setMaintenanceCleaning(client, stageId, value);
      setCleaning(value);
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível marcar a limpeza."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className={stage1Styles.hint} style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input type="checkbox" checked={cleaning} disabled={disabled || busy} onChange={(e) => void toggle(e.target.checked)} />
      <span>
        <strong>Limpeza</strong>: conta como uma manutenção (soma com as peças trocadas, se houver).
      </span>
    </label>
  );
}
