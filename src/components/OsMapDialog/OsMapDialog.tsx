import { useEffect, useRef, useState } from "react";
import { KIND_LABELS } from "../../domain/checklist";
import { splitAssetId } from "../../domain/device";
import { destinationLabelFor, parseDestination } from "../../domain/maintenance";
import {
  allStagesDone,
  analysisSenders,
  quarantineSenders,
  rejections,
  stageProgress,
  type OsMap,
  type StageState,
} from "../../domain/serviceOrder";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchOsMap } from "../../services/supabase/serviceOrderService";
import { formatDateTime } from "../../utils/format";
import { Button } from "../Button/Button";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import styles from "./OsMapDialog.module.css";

const STATE_LABELS: Record<StageState, string> = {
  feito: "Feito",
  andamento: "Em andamento",
  nao_feito: "Não feito",
};

interface OsMapDialogProps {
  client: AppSupabaseClient;
  /** Id da OS aberta; null mantém a janela fechada. */
  osId: string | null;
  onClose: () => void;
}

/** O mapa de uma OS: data, quem fez cada etapa, se todos os checklists foram feitos e as reprovações. */
export function OsMapDialog({ client, osId, onClose }: OsMapDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [map, setMap] = useState<OsMap | null | "missing">(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (osId && !element.open) element.showModal();
    if (!osId && element.open) element.close();
  }, [osId]);

  useEffect(() => {
    if (!osId) return;
    let active = true;
    setMap(null);
    setFailed(false);
    fetchOsMap(client, osId)
      .then((found) => active && setMap(found ?? "missing"))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, osId]);

  const content = (() => {
    if (failed) return <div className={recordStyles.empty}>Não foi possível carregar o mapa desta OS.</div>;
    if (map === "missing") return <div className={recordStyles.empty}>OS não encontrada ou sem acesso.</div>;
    if (!map) return <div className={recordStyles.empty}>Carregando…</div>;

    const progress = stageProgress(map);
    const rejected = rejections(map);
    const senders = quarantineSenders(map);
    const analysis = analysisSenders(map);
    const complete = allStagesDone(progress);
    const asset = map.unit ? splitAssetId(map.unit) : null;
    const timeline = [
      ...map.steps.map((step) => ({
        at: step.concludedAt ?? step.createdAt,
        label: KIND_LABELS[step.kind],
        person: step.person,
        detail:
          step.phase === "pendente"
            ? "em andamento"
            : [
                step.status === "reprovado" ? "reprovado" : step.status === "liberado" ? "aprovado" : step.status,
                (() => {
                  const destination = parseDestination(step.destination);
                  return destination ? destinationLabelFor(step.kind, destination) : "";
                })(),
              ]
                .filter(Boolean)
                .join(" · "),
      })),
      ...map.quarantine.map((entry) => ({
        at: entry.at,
        label: "Quarentena",
        person: entry.person,
        detail: entry.result === "reprovado" ? "reprovado" : "aprovado",
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    return (
      <>
        <p className={styles.sub}>
          {map.ordinal}ª OS de {map.total} deste ativo · {asset ? `Unit ${asset.code || map.unit} · ${asset.model}` : map.model ?? "sem modelo"} ·
          serial {map.serial}
        </p>
        <p className={styles.sub}>
          Registrada em {formatDateTime(map.createdAt)}
          {map.registeredBy && ` por ${map.registeredBy}`}
        </p>

        <h3 className={styles.heading}>Checklists</h3>
        <p className={complete ? styles.allOk : styles.notAll}>
          {complete ? "Todos os checklists foram feitos." : "Nem todos os checklists foram feitos."}
        </p>
        <ul className={styles.stages}>
          {progress.map((stage) => (
            <li key={stage.id}>
              <span className={styles.stageName}>{stage.label}</span>
              <span className={styles[`state-${stage.state}`]}>{STATE_LABELS[stage.state]}</span>
              <span className={styles.people}>{stage.people.join(", ") || "—"}</span>
            </li>
          ))}
        </ul>
        <ul className={styles.stages}>
          <li>
            <span className={styles.stageName}>Análise técnica</span>
            <span className={analysis.length ? styles["state-andamento"] : styles["state-nao_feito"]}>
              {analysis.length ? "Enviado" : "Não enviado"}
            </span>
            <span className={styles.people}>
              {analysis.map((item) => `${item.person} (${KIND_LABELS[item.stage]})`).join(", ") || "—"}
            </span>
          </li>
        </ul>
        <p className={styles.sub}>A análise técnica é um destino, não um checklist: não entra na conta dos checklists feitos.</p>
        {senders.length > 0 && <p className={styles.sub}>Enviou para a quarentena: {senders.join(", ")}</p>}

        <h3 className={styles.heading}>Reprovações</h3>
        {rejected.length ? (
          <ul className={styles.rejections}>
            {rejected.map((item, index) => (
              <li key={`${item.stage}-${item.at}-${index}`}>
                <strong>
                  {item.stage === "quarentena" ? "Quarentena" : KIND_LABELS[item.stage]} · {item.person} · {formatDateTime(item.at)}
                </strong>
                <span>{item.reasons.join(" · ") || "Sem motivo informado"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.sub}>Nenhuma reprovação nesta OS.</p>
        )}

        <h3 className={styles.heading}>Mapa da OS</h3>
        {timeline.length ? (
          <ol className={styles.timeline}>
            {timeline.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <span className={styles.when}>{formatDateTime(entry.at)}</span>
                <span>
                  <strong>{entry.label}</strong> · {entry.person}
                  {entry.detail && ` · ${entry.detail}`}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.sub}>Nenhum checklist foi feito nesta OS ainda.</p>
        )}
      </>
    );
  })();

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="os-map-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="os-map-title" className={styles.title}>
        {map && map !== "missing" ? `OS ${map.osNumber}` : "Ordem de serviço"}
      </h2>
      {content}
      <div className={styles.actions}>
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
      </div>
    </dialog>
  );
}
