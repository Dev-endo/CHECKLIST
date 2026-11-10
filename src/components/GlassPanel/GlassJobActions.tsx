import { useCallback, useEffect, useRef, useState } from "react";
import { toggleItemFailure } from "../../domain/device";
import { GLASS_DISPLAY_TEST, phaseCatalog, toggleBlockResult } from "../../domain/repairChecklist";
import type { Results, TestResult } from "../../domain/device";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  completeGlass,
  fetchGlassDisplay,
  finishGlass,
  glassSendDisplay,
  saveGlassDisplay,
  type GlassJob,
} from "../../services/supabase/glassService";
import { listMaintenanceTechnicians, type MaintenanceTechnician } from "../../services/supabase/repairService";
import { Button } from "../Button/Button";
import { Checklist } from "../Checklist/Checklist";
import styles from "./GlassPanel.module.css";

/** O único checklist do vidro: o de display (Tela e touch) que já existe na manutenção. */
const DISPLAY_BLOCK = phaseCatalog("aberto").find((block) => block.id === GLASS_DISPLAY_TEST);
const SAVE_DELAY_MS = 700;

type Run = (job: GlassJob, task: () => Promise<unknown>, done: string, fallback: string) => Promise<void>;

/**
 * Ações do serviço de vidro: o técnico só faz o vidro e testa a tela.
 * 1) "Concluir vidro" (sem espera do estoque nem cronômetro);
 * 2) checklist de display: tudo certo, aparece "Entregar ao responsável" (quem desmontou); falha, o aparelho vira
 *    display e o técnico escolhe quem faz;
 * 3) "Solicitar display" pode ser usado a qualquer momento depois do vidro, também escolhendo quem faz.
 * Nada disso cria pedido no estoque.
 */
export function GlassJobActions({ client, job, loading, direct, run }: { client: AppSupabaseClient; job: GlassJob; loading: boolean; direct: boolean; run: Run }) {
  const open = job.status === "aguardando" || job.status === "em_andamento";
  const concluded = job.status === "vidro_concluido";
  const [results, setResults] = useState<Results>({});
  const [loaded, setLoaded] = useState(false);
  const [technicians, setTechnicians] = useState<MaintenanceTechnician[]>([]);
  const [technicianId, setTechnicianId] = useState("");
  const dirty = useRef(false);
  const latest = useRef<Results>({});
  latest.current = results;

  // Lê o que já foi marcado (sem a migration 96 a coluna não existe: segue em branco).
  useEffect(() => {
    if (!concluded) return;
    let active = true;
    fetchGlassDisplay(client, job.id).then((found) => {
      if (!active) return;
      setResults(found);
      setLoaded(true);
    });
    listMaintenanceTechnicians(client)
      .then((found) => active && setTechnicians(found))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, job.id, concluded]);

  // Grava sozinho pouco depois de parar de marcar.
  const persist = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    try {
      await saveGlassDisplay(client, job.id, latest.current);
    } catch {
      dirty.current = true;
    }
  }, [client, job.id]);
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => void persist(), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [results, persist]);

  const edit = (change: (current: Results) => Results) => {
    dirty.current = true;
    setResults((current) => change(current));
  };
  const flushThen = (task: () => Promise<unknown>) => async () => {
    await persist();
    return task();
  };

  if (open) {
    return (
      <div className={styles.actions}>
        <Button disabled={loading} onClick={() => void run(job, () => completeGlass(client, job.id), "Vidro concluído", "Não foi possível concluir o vidro.")}>
          Concluir vidro
        </Button>
      </div>
    );
  }
  if (!concluded) return null;

  const answer = DISPLAY_BLOCK ? results[DISPLAY_BLOCK.id] : undefined;
  const failed = answer === "fail";
  // Aparelho que chegou direto no vidro segue pelo checklist do Estágio 2 (só o display); os demais voltam ao responsável.
  const showDisplayCheck = !direct && DISPLAY_BLOCK;
  const technicianName = technicians.find((item) => item.id === technicianId)?.name;

  const sendDisplay = () => {
    if (!technicianId) return;
    if (!window.confirm(`Enviar o aparelho para ${technicianName ?? "o técnico"} trocar o display? Nada é pedido ao estoque.`)) return;
    void run(job, flushThen(() => glassSendDisplay(client, job.id, technicianId)), `Display enviado para ${technicianName ?? "o técnico"}`, "Não foi possível enviar o display.");
  };

  const picker = (
    <label className={styles.muted}>
      Quem faz o display?{" "}
      <select value={technicianId} disabled={loading} onChange={(e) => setTechnicianId(e.target.value)}>
        <option value="">{technicians.length ? "Escolha o técnico…" : "Nenhum técnico encontrado"}</option>
        {technicians.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      {showDisplayCheck && DISPLAY_BLOCK && (
        <div>
          <p className={styles.muted}>Checklist de display: marque o resultado.</p>
          {loaded ? (
            <Checklist
              kind="manutencao"
              blocks={[DISPLAY_BLOCK]}
              results={results}
              onToggle={(_sectionId, result: TestResult) => edit((current) => toggleBlockResult(current, DISPLAY_BLOCK, result) as Results)}
              onToggleItem={(sectionId, itemId) => edit((current) => toggleItemFailure(current, sectionId, itemId))}
              onConfirm={() => undefined}
              disabled={loading}
            />
          ) : (
            <p className={styles.muted}>Carregando…</p>
          )}
        </div>
      )}

      {failed && (
        <p className={styles.muted} role="status">
          <strong>Display reprovado:</strong> o aparelho vira display. Escolha quem vai fazer.
        </p>
      )}

      <div className={styles.actions}>
        {direct && (
          <Button
            disabled={loading}
            onClick={() => void run(job, () => finishGlass(client, job.id), "Vidro entregue: siga para o checklist de display", "Não foi possível seguir para o checklist.")}
          >
            Seguir para o checklist
          </Button>
        )}
        {!direct && answer === "ok" && (
          <Button
            disabled={loading}
            onClick={() => void run(job, flushThen(() => finishGlass(client, job.id)), `Entregue a ${job.responsible}`, "Não foi possível entregar o aparelho.")}
          >
            Entregar ao responsável ({job.responsible})
          </Button>
        )}
        {!direct && !answer && <span className={styles.muted}>Responda o checklist de display para entregar ao responsável.</span>}
        {picker}
        <Button variant="danger" disabled={loading || !technicianId} onClick={sendDisplay}>
          {failed ? "Enviar display" : "Solicitar display"}
        </Button>
      </div>
    </>
  );
}
