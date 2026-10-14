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
import type { ChecklistKind } from "../../domain/checklist";
import { useAutosave } from "../../hooks/useAutosave";
import { useDeviceDraft } from "../../hooks/useDeviceDraft";
import { useDeviceRecords } from "../../hooks/useDeviceRecords";
import { useRepository } from "../../hooks/useRepository";
import { lookupAsset } from "../../services/supabase/assetsService";
import appStyles from "../../App.module.css";
import { Checklist } from "../Checklist/Checklist";
import { DeviceForm } from "../DeviceForm/DeviceForm";
import { DisassemblyDialog, type DisassemblyOutcome } from "../DisassemblyDialog/DisassemblyDialog";
import { DuplicateHint } from "../DuplicateHint/DuplicateHint";
import { RecordsPanel } from "../RecordsPanel/RecordsPanel";
import { StatusBar } from "../StatusBar/StatusBar";
import { useToast } from "../Toast/ToastProvider";

interface DisassemblyChecklistProps {
  kind: Extract<ChecklistKind, "desmontagem" | "desmontagem_tecnica">;
}

/** Desmontagem e desmontagem técnica: mesmos testes; muda o que se pergunta ao concluir. */
export function DisassemblyChecklist({ kind }: DisassemblyChecklistProps) {
  const technical = kind === "desmontagem_tecnica";
  const label = technical ? "Desmontagem técnica" : "Desmontagem";
  const toast = useToast();
  const { user, client } = useAuth();
  const userId = user?.id ?? "";
  const repository = useRepository(userId, kind);
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
  } = useDeviceDraft(user ? user.name || user.email : "", kind);

  const [concluding, setConcluding] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  // missing: o serial não está na planilha de ativos (segue permitido, só avisa).
  const [assetState, setAssetState] = useState<"idle" | "found" | "missing">("idle");

  const editable = isEditable(draft, userId);
  const duplicate = findDuplicate(draft, records);
  const blockedByDuplicate = Boolean(duplicate && isPending(duplicate));

  // Ao bipar o serial, busca o ativo e preenche unit id e modelo.
  const serial = draft.serial.trim();
  useEffect(() => {
    if (!client || !editable) return;
    if (!serial) {
      setAssetState("idle");
      if (draft.ativo) clearAsset();
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      lookupAsset(client, serial)
        .then((asset) => {
          if (!active) return;
          if (asset) {
            setAssetState("found");
            if (draft.ativo !== asset.assetShortId || draft.modelo !== asset.model) {
              applyAsset(asset.assetShortId, asset.model);
            }
          } else {
            setAssetState("missing");
            if (draft.ativo) clearAsset();
          }
        })
        .catch(() => active && setAssetState("idle"));
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
    enabled: editable && !blockedByDuplicate,
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
    window.scrollTo(0, 0);
    toast("Novo checklist em branco");
  };

  const handleConclude = () => {
    if (!isIdentified(draft)) {
      toast("Preencha serial, modelo e técnico para concluir");
      return;
    }
    if (blockedByDuplicate) {
      toast("Retome ou reinicie o checklist pendente deste serial");
      return;
    }
    const unconfirmed = missingConfirmations(draft.r, kind);
    if (unconfirmed.length) {
      toast(`Confirme para concluir: ${unconfirmed.map((item) => item.title).join(", ")}`);
      return;
    }
    const { pending } = computeStats(draft.r, kind);
    if (
      pending.length &&
      !window.confirm(`Faltam ${pending.length} tópicos sem teste. Concluir mesmo assim? Depois de concluído, não dá para alterar.`)
    ) {
      return;
    }
    setDialogOpen(true);
  };

  const finishConclude = async (outcome: DisassemblyOutcome) => {
    setConcluding(true);
    const ok = await conclude({
      ...draft,
      destino: outcome.destination,
      bloqueado: outcome.blocked,
      tampaAlta: outcome.highLid,
      defeito: outcome.bootIssue,
      manutencoes: outcome.parts ?? [],
    });
    setConcluding(false);
    setDialogOpen(false);
    if (ok) {
      startNew();
      window.scrollTo(0, 0);
      toast("Checklist concluído");
    } else {
      toast("Não foi possível concluir. Tente de novo.");
    }
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
        <h1 className={appStyles.title}>{label} · iPhone</h1>
        <p className={appStyles.subtitle}>
          Testes com o aparelho aberto. Marque OK ou Falha em cada tópico, confirme o serial e conclua para direcionar o
          aparelho.
        </p>
        <DeviceForm
          draft={draft}
          onChange={setField}
          disabled={!editable}
          lockedFields={[...(user ? ["tec" as const] : []), ...(draft.ativo ? ["modelo" as const] : [])]}
          unitId={draft.ativo ? splitAssetId(draft.ativo).code || draft.ativo : undefined}
        />
        {editable && client && assetState === "missing" && (
          <p className={appStyles.hint}>Serial não encontrado na lista de ativos. Preencha o modelo manualmente.</p>
        )}
        {editable && <DuplicateHint draft={draft} records={records} onOpen={handleOpen} onRestart={handleRestart} />}
      </header>

      {banner && (
        <div className={appStyles.banner} role="alert">
          {banner}
        </div>
      )}

      <Checklist
        kind={kind}
        results={draft.r}
        onToggle={toggleResult}
        onToggleItem={toggleItemFail}
        onConfirm={setConfirm}
        disabled={!editable}
      />

      <RecordsPanel records={records} loaded={loaded} currentId={draft.id} onOpen={handleOpen} onRestart={handleRestart} />

      <p className={appStyles.note}>
        Depois de preencher modelo, serial e técnico, cada marcação é salva sozinha e o aparelho fica pendente. Concluir
        pergunta o direcionamento, finaliza o checklist e começa um novo.
      </p>

      <StatusBar
        kind={kind}
        results={draft.r}
        saveState={saveState}
        mode={editable ? "edit" : "view"}
        busy={concluding}
        concludeLabel={technical ? "Concluir desmontagem técnica" : "Concluir desmontagem"}
        onConclude={handleConclude}
        onNewDevice={handleNew}
      />
      <DisassemblyDialog
        open={dialogOpen}
        busy={concluding}
        technical={technical}
        onCancel={() => setDialogOpen(false)}
        onConfirm={(outcome) => void finishConclude(outcome)}
      />
    </>
  );
}
