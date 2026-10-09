import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import {
  computeStats,
  findDuplicate,
  isEditable,
  isIdentified,
  isPending,
  missingConfirmations,
  splitAssetId,
  type DeviceRecord,
} from "../../domain/device";
import type { Maintenance } from "../../domain/maintenance";
import { useAutosave } from "../../hooks/useAutosave";
import { useDeviceDraft } from "../../hooks/useDeviceDraft";
import { useDeviceRecords } from "../../hooks/useDeviceRecords";
import { useRepository } from "../../hooks/useRepository";
import { lookupAsset } from "../../services/supabase/assetsService";
import { describeAssemblyBlock, fetchAssemblySource } from "../../services/supabase/assemblyService";
import appStyles from "../../App.module.css";
import { AssemblyFailureDialog } from "../AssemblyFailureDialog/AssemblyFailureDialog";
import { Checklist } from "../Checklist/Checklist";
import { DeviceForm } from "../DeviceForm/DeviceForm";
import { DuplicateHint } from "../DuplicateHint/DuplicateHint";
import { RecordsPanel } from "../RecordsPanel/RecordsPanel";
import { StatusBar } from "../StatusBar/StatusBar";
import { useToast } from "../Toast/ToastProvider";

type SourceState =
  | { state: "idle" }
  /** Liberado para montagem pelo último checklist de manutenção. */
  | { state: "ok"; deviceId: string; technician: string }
  | { state: "blocked"; message: string }
  | { state: "error" };

/** Checklist de montagem: testes básicos de um aparelho liberado para montagem pela manutenção. */
export function AssemblyChecklist() {
  const toast = useToast();
  const { user, client } = useAuth();
  const userId = user?.id ?? "";
  const repository = useRepository(userId, "montagem");
  const { records, loaded, failed } = useDeviceRecords(repository);
  const {
    draft,
    revision,
    setField,
    toggleResult,
    toggleItemFail,
    setConfirm,
    openRecord,
    restartRecord,
    startNew,
    applyAsset,
    clearAsset,
    markCreated,
  } = useDeviceDraft(user ? user.name || user.email : "", "montagem");

  const [source, setSource] = useState<SourceState>({ state: "idle" });
  const [concluding, setConcluding] = useState(false);
  // Montagem reprovada: antes de concluir, pergunta a peça e de quem foi o erro.
  const [failureOpen, setFailureOpen] = useState(false);

  const editable = isEditable(draft, userId);
  const duplicate = findDuplicate(draft, records);
  const blockedByDuplicate = Boolean(duplicate && isPending(duplicate));
  const blockedByRelease = editable && source.state === "blocked";

  // Ao bipar o serial: preenche modelo e unit id e confere se a manutenção liberou o aparelho para montagem.
  const serial = draft.serial.trim();
  useEffect(() => {
    if (!client || !editable) return;
    if (!serial) {
      setSource({ state: "idle" });
      if (draft.ativo) clearAsset();
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      Promise.all([lookupAsset(client, serial), fetchAssemblySource(client, serial)])
        .then(([asset, found]) => {
          if (!active) return;
          if (asset) {
            if (draft.ativo !== asset.assetShortId || draft.modelo !== asset.model) {
              applyAsset(asset.assetShortId, asset.model);
            }
          } else if (draft.ativo) {
            clearAsset();
          }
          const reason = describeAssemblyBlock(found);
          if (!found || reason) setSource({ state: "blocked", message: reason ?? "Aparelho não encontrado." });
          else setSource({ state: "ok", deviceId: found.deviceId, technician: found.technician });
        })
        .catch(() => active && setSource({ state: "error" }));
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, editable, serial]);

  const { saveState, readOnly, conclude } = useAutosave({
    repository,
    draft,
    revision,
    // Só aparelhos liberados para montagem são gravados.
    enabled: editable && !blockedByDuplicate && source.state === "ok",
    onCreated: markCreated,
  });

  const handleOpen = useCallback(
    (record: DeviceRecord) => {
      openRecord(record);
      window.scrollTo(0, 0);
      toast("Registro aberto");
    },
    [openRecord, toast],
  );

  const handleRestart = (record: DeviceRecord) => {
    if (!window.confirm("Reiniciar apaga todas as marcações deste checklist pendente. Continuar?")) return;
    restartRecord(record);
    window.scrollTo(0, 0);
    toast("Checklist reiniciado");
  };

  const handleNew = () => {
    startNew();
    setSource({ state: "idle" });
    window.scrollTo(0, 0);
    toast("Novo checklist em branco");
  };

  const finishConclude = async (parts: Maintenance[] = []) => {
    if (source.state !== "ok") return;
    setConcluding(true);
    const ok = await conclude({ ...draft, pecas: parts, origem: source.deviceId });
    setConcluding(false);
    setFailureOpen(false);
    if (ok) {
      startNew();
      setSource({ state: "idle" });
      window.scrollTo(0, 0);
      toast("Checklist concluído");
    } else {
      toast("Não foi possível concluir. Tente de novo.");
    }
  };

  const handleConclude = async () => {
    if (!isIdentified(draft)) {
      toast("Preencha serial, modelo e técnico para concluir");
      return;
    }
    if (source.state !== "ok") {
      toast("Só aparelhos liberados para montagem podem ser montados");
      return;
    }
    if (blockedByDuplicate) {
      toast("Retome ou reinicie o checklist pendente deste serial");
      return;
    }
    const unconfirmed = missingConfirmations(draft.r, "montagem");
    if (unconfirmed.length) {
      toast(`Confirme para concluir: ${unconfirmed.map((item) => item.title).join(", ")}`);
      return;
    }
    const stats = computeStats(draft.r, "montagem");
    if (
      stats.pending.length &&
      !window.confirm(
        `Faltam ${stats.pending.length} tópicos sem teste. Concluir mesmo assim? Depois de concluído, não dá para alterar.`,
      )
    ) {
      return;
    }
    if (stats.status === "reprovado") {
      setFailureOpen(true);
      return;
    }
    await finishConclude();
  };

  let banner: string | null = null;
  if (readOnly) banner = "Você pode consultar os registros, mas não salvar.";
  else if (failed) banner = "Não foi possível carregar os registros agora. Recarregue a página.";
  else if (!editable) {
    banner = draft.autor && draft.autor !== userId ? "Checklist de outra pessoa: somente leitura." : "Checklist concluído: somente leitura.";
  }

  return (
    <>
      <header>
        <h1 className={appStyles.title}>Checklist de montagem · iPhone</h1>
        <p className={appStyles.subtitle}>
          Testes básicos depois da manutenção. Marque OK ou Falha em cada tópico; qualquer falha reprova e pede a peça com
          erro.
        </p>
        <DeviceForm
          draft={draft}
          onChange={setField}
          disabled={!editable}
          lockedFields={[...(user ? ["tec" as const] : []), ...(draft.ativo ? ["modelo" as const] : [])]}
          unitId={draft.ativo ? splitAssetId(draft.ativo).code || draft.ativo : undefined}
        />
        {editable && source.state === "ok" && (
          <p className={appStyles.hint}>Liberado para montagem pela manutenção ({source.technician}).</p>
        )}
        {blockedByRelease && source.state === "blocked" && (
          <p className={appStyles.banner} role="alert">
            {source.message} Este aparelho não pode ser montado.
          </p>
        )}
        {editable && source.state === "error" && (
          <p className={appStyles.hint}>Não foi possível conferir a liberação deste aparelho. Tente de novo.</p>
        )}
        {editable && <DuplicateHint draft={draft} records={records} onOpen={handleOpen} onRestart={handleRestart} />}
      </header>

      {banner && (
        <div className={appStyles.banner} role="alert">
          {banner}
        </div>
      )}

      <Checklist
        kind="montagem"
        results={draft.r}
        onToggle={toggleResult}
        onToggleItem={toggleItemFail}
        onConfirm={setConfirm}
        disabled={!editable || blockedByRelease}
      />

      <RecordsPanel
        records={records}
        loaded={loaded}
        currentId={draft.id}
        onOpen={handleOpen}
        onRestart={handleRestart}
      />

      <p className={appStyles.note}>
        Depois de bipar o serial de um aparelho liberado para montagem, cada marcação é salva sozinha e o aparelho fica
        pendente. Concluir finaliza o checklist e começa um novo. Se reprovar, informe a peça com erro.
      </p>

      <StatusBar
        kind="montagem"
        results={draft.r}
        saveState={saveState}
        mode={editable ? "edit" : "view"}
        busy={concluding}
        onConclude={() => void handleConclude()}
        onNewDevice={handleNew}
      />
      <AssemblyFailureDialog
        open={failureOpen}
        busy={concluding}
        onCancel={() => setFailureOpen(false)}
        onConfirm={(parts) => void finishConclude(parts)}
      />
    </>
  );
}
