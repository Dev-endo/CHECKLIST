import { useCallback, useEffect, useRef, useState } from "react";
import { toggleItemFailure } from "../../domain/device";
import { GLASS_DISPLAY_TEST, phaseCatalog, toggleBlockResult } from "../../domain/repairChecklist";
import type { Results, TestResult } from "../../domain/device";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  completeGlass,
  fetchGlassDisplay,
  finishGlass,
  finishGlassDirect,
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
 * 2) checklist de display; 3) entregar ao responsável (quem desmontou) ou enviar para outro técnico.
 * "Troca de display" é só uma marca (vem sozinha quando o teste falha, ou o técnico marca antes do teste): não depende
 * de enviar para outro técnico e não pede nada ao estoque.
 */
export function GlassJobActions({ client, job, loading, direct, run }: { client: AppSupabaseClient; job: GlassJob; loading: boolean; direct: boolean; run: Run }) {
  const open = job.status === "aguardando" || job.status === "em_andamento";
  const concluded = job.status === "vidro_concluido";
  const [results, setResults] = useState<Results>({});
  const [loaded, setLoaded] = useState(false);
  const [technicians, setTechnicians] = useState<MaintenanceTechnician[]>([]);
  // Troca de display pedida à mão (a falha no teste também pede, sozinha).
  const [displayAsked, setDisplayAsked] = useState(false);
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
  const showDisplayCheck = DISPLAY_BLOCK;
  const wantsDisplay = failed || displayAsked;
  // Pode finalizar com o teste respondido, ou com a troca de display já solicitada (antes do teste).
  const canFinish = Boolean(answer) || wantsDisplay;

  // Escolher o técnico envia o aparelho para ele e finaliza o vidro (com uma confirmação); é independente da troca de display.
  const sendToTechnician = (technicianId: string) => {
    if (!technicianId) return;
    const name = technicians.find((item) => item.id === technicianId)?.name ?? "o técnico";
    if (!window.confirm(`Enviar o aparelho para ${name}? O vidro é finalizado${wantsDisplay ? " com a troca de display solicitada" : ""}.`)) return;
    void run(job, flushThen(() => glassSendDisplay(client, job.id, technicianId, wantsDisplay)), `Aparelho enviado para ${name}`, "Não foi possível enviar o aparelho.");
  };

  const picker = (
    <label className={styles.muted}>
      Enviar para outro técnico:{" "}
      <select value="" disabled={loading || !canFinish} onChange={(e) => sendToTechnician(e.target.value)}>
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

      <label className={styles.muted} style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={wantsDisplay} disabled={loading || failed} onChange={(e) => setDisplayAsked(e.target.checked)} />
        <span>
          <strong>Solicitar troca de display</strong>
          {failed ? " (display reprovado no teste: já solicitada)" : " (pode marcar antes do teste)"}
        </span>
      </label>

      <div className={styles.actions}>
        {direct && canFinish && (
          <Button
            disabled={loading}
            onClick={() => void run(job, flushThen(() => finishGlassDirect(client, job.id, wantsDisplay)), "Vidro finalizado", "Não foi possível finalizar o vidro.")}
          >
            Finalizar vidro
          </Button>
        )}
        {!direct && canFinish && (
          <Button
            disabled={loading}
            onClick={() => void run(job, flushThen(() => finishGlass(client, job.id, wantsDisplay)), `Entregue a ${job.responsible}`, "Não foi possível entregar o aparelho.")}
          >
            Entregar ao responsável ({job.responsible})
          </Button>
        )}
        {!canFinish && <span className={styles.muted}>Responda o checklist de display (ou solicite a troca) para {direct ? "finalizar" : "entregar ao responsável"}.</span>}
        {picker}
      </div>
    </>
  );
}
