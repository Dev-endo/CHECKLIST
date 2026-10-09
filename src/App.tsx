import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "./auth/AuthProvider";
import { AdminPanel } from "./components/AdminPanel/AdminPanel";
import { AppHeader, type AppTab } from "./components/AppHeader/AppHeader";
import { Checklist } from "./components/Checklist/Checklist";
import { DeviceForm } from "./components/DeviceForm/DeviceForm";
import { DuplicateHint } from "./components/DuplicateHint/DuplicateHint";
import { RecordsPanel } from "./components/RecordsPanel/RecordsPanel";
import { AssemblyChecklist } from "./components/AssemblyChecklist/AssemblyChecklist";
import { MaintenanceDialog } from "./components/MaintenanceDialog/MaintenanceDialog";
import { ReviewSection } from "./components/ReviewSection/ReviewSection";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { useToast } from "./components/Toast/ToastProvider";
import {
  computeStats,
  findDuplicate,
  hasContent,
  hasFaceIdDefect,
  isEditable,
  isIdentified,
  isPending,
  missingConfirmations,
  splitAssetId,
  type DeviceRecord,
} from "./domain/device";
import type { Destination, Maintenance } from "./domain/maintenance";
import { accessibleTabs } from "./domain/roles";
import { useAutosave } from "./hooks/useAutosave";
import { useDeviceDraft } from "./hooks/useDeviceDraft";
import { useDeviceRecords } from "./hooks/useDeviceRecords";
import { useReleasedIds } from "./hooks/useReleasedIds";
import { useRepository } from "./hooks/useRepository";
import { preferences } from "./services/preferences";
import { lookupAsset } from "./services/supabase/assetsService";
import styles from "./App.module.css";

export default function App() {
  const toast = useToast();
  const { user, client, signOut } = useAuth();
  const userId = user?.id ?? "";
  const repository = useRepository(userId);
  const { records, loaded, failed } = useDeviceRecords(repository);
  const releasedIds = useReleasedIds(client, records);
  const {
    draft,
    revision,
    setField,
    toggleResult,
    toggleItemFail,
    setBattery,
    setConfirm,
    openRecord,
    restartRecord,
    startNew,
    applyAsset,
    clearAsset,
    markCreated,
  } = useDeviceDraft(user ? user.name || user.email : preferences.getLastTech());

  // missing: o serial não está na planilha de ativos (segue permitido, só avisa).
  const [assetState, setAssetState] = useState<"idle" | "found" | "missing">("idle");
  // Cada papel abre na primeira aba a que tem acesso (sem login, no modo local, só há o checklist).
  const allowedTabs: AppTab[] = user ? accessibleTabs(user.role) : ["checklist"];
  const [tab, setTab] = useState<AppTab>(allowedTabs[0] ?? "checklist");
  const [concluding, setConcluding] = useState(false);
  // Checklist com tudo OK: antes de concluir, pergunta as manutenções realizadas.
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);

  // Pendente do próprio usuário pode ser alterado; concluído e de outros, só consulta.
  const editable = isEditable(draft, userId);
  // Outro checklist pendente com o mesmo serial: o usuário escolhe retomar ou reiniciar antes de salvar.
  const duplicate = findDuplicate(draft, records);
  const blocked = Boolean(duplicate && isPending(duplicate));

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
    enabled: editable && !blocked,
    onCreated: markCreated,
  });

  // Quem só consulta (supervisor) vê o checklist de manutenção aberto a partir do registro, só leitura.
  const tabs: AppTab[] = tab === "checklist" && !allowedTabs.includes("checklist") && allowedTabs.length ? ["checklist", ...allowedTabs] : allowedTabs;
  const activeTab: AppTab | undefined = tabs.includes(tab) ? tab : tabs[0];
  const noAccess = tabs.length === 0;

  const handleOpen = useCallback(
    (record: DeviceRecord) => {
      openRecord(record);
      setTab("checklist");
      window.scrollTo(0, 0);
      toast("Registro aberto");
    },
    [openRecord, toast],
  );

  const handleRestart = (record: DeviceRecord) => {
    if (!window.confirm("Reiniciar apaga todas as marcações deste checklist pendente. Continuar?")) return;
    restartRecord(record);
    setTab("checklist");
    window.scrollTo(0, 0);
    toast("Checklist reiniciado");
  };

  const handleNew = () => {
    startNew();
    window.scrollTo(0, 0);
    toast("Novo checklist em branco");
  };

  const handleConclude = async () => {
    if (!isIdentified(draft)) {
      toast("Preencha modelo, serial e técnico para concluir");
      return;
    }
    if (blocked) {
      toast("Retome ou reinicie o checklist pendente deste serial");
      return;
    }
    const unconfirmed = missingConfirmations(draft.r);
    if (unconfirmed.length) {
      toast(`Confirme para concluir: ${unconfirmed.map((item) => item.title).join(", ")}`);
      return;
    }
    const missing = computeStats(draft.r).pending.length;
    if (
      missing &&
      !window.confirm(`Faltam ${missing} itens sem teste. Concluir mesmo assim? Depois de concluído, não dá para alterar.`)
    ) {
      return;
    }
    const outcome = computeStats(draft.r, draft.tipo).status;
    if (outcome === "liberado" || outcome === "reprovado") {
      setMaintenanceOpen(true);
      return;
    }
    await finishConclude([]);
  };

  const finishConclude = async (maintenances: Maintenance[], destino?: Destination) => {
    setConcluding(true);
    const ok = await conclude({ ...draft, manutencoes: maintenances, destino });
    setConcluding(false);
    setMaintenanceOpen(false);
    if (ok) {
      startNew();
      window.scrollTo(0, 0);
      toast("Checklist concluído");
    } else {
      toast("Não foi possível concluir. Tente de novo.");
    }
  };

  // Na primeira carga, reabre o aparelho pendente em que este navegador estava.
  const [lastDeviceId] = useState(preferences.getCurrentDeviceId);
  const restored = useRef(false);
  useEffect(() => {
    if (!loaded || restored.current) return;
    restored.current = true;
    const last = records.find((r) => r.id === lastDeviceId);
    if (last && isPending(last) && last.id !== draft.id && !hasContent(draft)) handleOpen(last);
  }, [loaded, records, lastDeviceId, draft, handleOpen]);

  let banner: string | null = null;
  if (readOnly) banner = "Você pode consultar os registros, mas não salvar. Peça acesso de Colaborador à página.";
  else if (failed) banner = "Não foi possível carregar os registros agora. Recarregue a página.";
  else if (!editable) {
    banner =
      draft.autor && draft.autor !== userId
        ? `Checklist de ${draft.colaborador ?? "outro colaborador"}: somente leitura.`
        : "Checklist concluído: somente leitura.";
  }

  return (
    <>
      <AppHeader tabs={tabs} active={activeTab ?? "checklist"} onChange={setTab} user={user} onSignOut={() => void signOut()} />

      <main className={styles.wrap}>
        {noAccess && (
          <div className={styles.banner} role="alert">
            Seu acesso ainda não foi liberado. Peça ao administrador para definir o seu papel.
          </div>
        )}
        {activeTab === "montagem" && <AssemblyChecklist />}
        {activeTab === "registros" && client && <ReviewSection client={client} onOpen={handleOpen} />}
        {activeTab === "admin" && client && <AdminPanel client={client} currentUserId={userId} />}

        {activeTab === "checklist" && (
          <>
            <header>
              <h1 className={styles.title}>Checklist de manutenção · iPhone</h1>
              <DeviceForm
                draft={draft}
                onChange={setField}
                disabled={!editable}
                lockedFields={[...(user ? ["tec" as const] : []), ...(draft.ativo ? ["modelo" as const] : [])]}
                unitId={draft.ativo ? splitAssetId(draft.ativo).code || draft.ativo : undefined}
              />
              {editable && client && assetState === "missing" && (
                <p className={styles.hint}>Serial não encontrado na lista de ativos. Preencha o modelo manualmente.</p>
              )}
              {editable && <DuplicateHint draft={draft} records={records} onOpen={handleOpen} onRestart={handleRestart} />}
            </header>

            {banner && (
              <div className={styles.banner} role="alert">
                {banner}
              </div>
            )}

            <Checklist
              results={draft.r}
              onToggle={toggleResult}
              onToggleItem={toggleItemFail}
              battery={draft.bateria}
              onBatteryChange={setBattery}
              onConfirm={setConfirm}
              disabled={!editable}
            />

            <RecordsPanel
              records={records}
              loaded={loaded}
              currentId={draft.id}
              onOpen={handleOpen}
              onRestart={handleRestart}
              releasedIds={releasedIds}
            />

            <p className={styles.note}>
              {repository?.kind === "local"
                ? "Cada marcação é salva neste navegador. "
                : "Depois de preencher modelo, serial e técnico, cada marcação é salva sozinha e o aparelho fica pendente. "}
              Concluir finaliza o checklist e começa um novo; só os pendentes podem ser alterados.
            </p>
          </>
        )}
      </main>

      {activeTab === "checklist" && (
        <StatusBar
          results={draft.r}
          saveState={saveState}
          mode={editable ? "edit" : "view"}
          busy={concluding}
          onConclude={() => void handleConclude()}
          onNewDevice={handleNew}
        />
      )}
      <MaintenanceDialog
        open={maintenanceOpen}
        busy={concluding}
        faceIdDefect={hasFaceIdDefect(draft.r, draft.tipo)}
        rejected={computeStats(draft.r, draft.tipo).status === "reprovado"}
        onCancel={() => setMaintenanceOpen(false)}
        onConfirm={(maintenances, destination) => void finishConclude(maintenances, destination)}
      />
    </>
  );
}
