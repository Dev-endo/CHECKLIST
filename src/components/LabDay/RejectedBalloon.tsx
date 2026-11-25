import { useCallback, useEffect, useState } from "react";
import { describeRepairError } from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchRejected, listLabTechnicians, redistributeRejected, type LabTechnician, type RejectedAsset } from "../../services/supabase/labDayService";
import { Button } from "../Button/Button";
import { useToast } from "../Toast/ToastProvider";
import styles from "./LabDay.module.css";

const POLL_MS = 30_000;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

/**
 * Balão fixo "Ativos reprovados": os reprovados na quarentena esperando o supervisor escolher quem faz a manutenção.
 * Zerado, fica desabilitado. Aberto, lista os ativos; o supervisor marca um ou mais e escolhe qualquer técnico.
 */
export function RejectedBalloon({ client, reloadKey = 0 }: { client: AppSupabaseClient; reloadKey?: number }) {
  const toast = useToast();
  const [rejected, setRejected] = useState<RejectedAsset[] | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [technicians, setTechnicians] = useState<LabTechnician[]>([]);
  const [technicianId, setTechnicianId] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchRejected(client)
        .then((found) => {
          if (!active) return;
          setRejected(found);
          // Some da seleção o que já saiu da lista.
          setSelected((current) => new Set([...current].filter((id) => found.some((item) => item.assetId === id))));
        })
        .catch(() => active && setRejected((current) => current ?? []));
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, reloads, reloadKey]);

  useEffect(() => {
    if (!open || technicians.length) return;
    listLabTechnicians(client)
      .then(setTechnicians)
      .catch(() => undefined);
  }, [client, open, technicians.length]);

  const count = rejected?.length ?? 0;
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = count > 0 && selected.size === count;
  const technician = technicians.find((item) => item.id === technicianId);

  const redistribute = async () => {
    if (!technician || !selected.size || busy) return;
    if (!window.confirm(`Enviar ${selected.size} ativo(s) reprovado(s) para ${technician.name}?`)) return;
    setBusy(true);
    try {
      const total = await redistributeRejected(client, [...selected], technician.id);
      toast(`${total} ativo(s) redistribuído(s) para ${technician.name}`);
      setSelected(new Set());
      reload();
    } catch (error) {
      const err = error as { message?: string; details?: string };
      const message = describeRepairError(err, "Não foi possível redistribuir.");
      toast(err.details ? `${message} (${err.details})` : message);
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Ativos reprovados">
      <h2 className={styles.section}>Reprovados na quarentena</h2>
      <button type="button" className={styles.rejected} disabled={!count} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <strong>Ativos reprovados</strong>
        <span className={styles.rejectedValue}>{rejected === null ? "…" : count}</span>
        <span className={styles.muted}>
          {count ? "aguardando redistribuição: clique para escolher o técnico" : "nenhum ativo reprovado aguardando"}
        </span>
      </button>

      {open && rejected && count > 0 && (
        <div className={styles.list}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Selecionar todos"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(rejected.map((item) => item.assetId)))}
                    />
                  </th>
                  <th>Serial</th>
                  <th>Unit ID</th>
                  <th>Último técnico</th>
                  <th>Reprovado em</th>
                </tr>
              </thead>
              <tbody>
                {rejected.map((item) => (
                  <tr key={item.assetId}>
                    <td>
                      <input type="checkbox" aria-label={`Selecionar ${item.serial}`} checked={selected.has(item.assetId)} onChange={() => toggle(item.assetId)} />
                    </td>
                    <td className={styles.mono}>{item.serial}</td>
                    <td>{item.unit ?? "—"}</td>
                    <td>{item.lastTechnician ?? "—"}</td>
                    <td>{when(item.rejectedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.actions}>
            <label className={styles.muted}>
              Técnico:{" "}
              <select value={technicianId} disabled={busy} onChange={(e) => setTechnicianId(e.target.value)}>
                <option value="">Escolha…</option>
                {technicians.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <Button disabled={busy || !selected.size || !technician} onClick={() => void redistribute()}>
              Enviar para o técnico{selected.size ? ` (${selected.size})` : ""}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
