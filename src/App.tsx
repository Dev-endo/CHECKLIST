import { useCallback, useEffect, useRef, useState } from "react";
import { Checklist } from "./components/Checklist/Checklist";
import { DeviceForm } from "./components/DeviceForm/DeviceForm";
import { DuplicateHint } from "./components/DuplicateHint/DuplicateHint";
import { RecordsPanel } from "./components/RecordsPanel/RecordsPanel";
import { ReportFallback } from "./components/ReportFallback/ReportFallback";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { useToast } from "./components/Toast/ToastProvider";
import { hasContent, type DeviceRecord } from "./domain/device";
import { buildReport } from "./domain/report";
import { useAutosave } from "./hooks/useAutosave";
import { useDeviceDraft } from "./hooks/useDeviceDraft";
import { useDeviceRecords } from "./hooks/useDeviceRecords";
import { useRepository } from "./hooks/useRepository";
import { preferences } from "./services/preferences";
import styles from "./App.module.css";

export default function App() {
  const toast = useToast();
  const repository = useRepository();
  const { records, loaded, failed } = useDeviceRecords(repository);
  const { draft, revision, setField, toggleResult, openRecord, startNew, markCreated } = useDeviceDraft();
  const { saveState, readOnly } = useAutosave({ repository, draft, revision, onCreated: markCreated });
  const [reportFallback, setReportFallback] = useState<string | null>(null);

  const handleOpen = useCallback(
    (record: DeviceRecord) => {
      openRecord(record);
      setReportFallback(null);
      window.scrollTo(0, 0);
      toast("Registro aberto");
    },
    [openRecord, toast],
  );

  const handleNew = () => {
    startNew();
    setReportFallback(null);
    window.scrollTo(0, 0);
    toast("Novo checklist em branco");
  };

  const handleCopyReport = async () => {
    const text = buildReport(draft);
    try {
      await navigator.clipboard.writeText(text);
      setReportFallback(null);
      toast("Laudo copiado");
    } catch {
      setReportFallback(text);
      toast("Selecione e copie o texto");
    }
  };

  // Na primeira carga, reabre o aparelho em que este navegador estava.
  const [lastDeviceId] = useState(preferences.getCurrentDeviceId);
  const restored = useRef(false);
  useEffect(() => {
    if (!loaded || restored.current) return;
    restored.current = true;
    const last = records.find((r) => r.id === lastDeviceId);
    if (last && last.id !== draft.id && !hasContent(draft)) handleOpen(last);
  }, [loaded, records, lastDeviceId, draft, handleOpen]);

  const banner = readOnly
    ? "Você pode consultar os registros, mas não salvar. Peça acesso de Colaborador à página."
    : failed
      ? "Não foi possível carregar os registros agora. Recarregue a página."
      : null;

  return (
    <>
      <main className={styles.wrap}>
        <header>
          <h1 className={styles.title}>Checklist de testes · iPhone</h1>
          <p className={styles.subtitle}>
            Testes funcionais com o aparelho aberto. Marque OK ou Falha em cada item; qualquer falha reprova.
          </p>
          <DeviceForm draft={draft} onChange={setField} />
          <DuplicateHint draft={draft} records={records} onOpen={handleOpen} />
        </header>

        {banner && (
          <div className={styles.banner} role="alert">
            {banner}
          </div>
        )}

        <Checklist results={draft.r} onToggle={toggleResult} />

        {reportFallback && <ReportFallback text={reportFallback} />}

        <RecordsPanel records={records} loaded={loaded} currentId={draft.id} onOpen={handleOpen} />

        <p className={styles.note}>
          {repository?.kind === "local"
            ? "Cada marcação é salva neste navegador. "
            : "Cada marcação é salva no registro do aparelho. "}
          Novo aparelho começa um checklist em branco; os anteriores ficam na lista acima.
        </p>
      </main>

      <StatusBar
        results={draft.r}
        saveState={saveState}
        onCopyReport={handleCopyReport}
        onNewDevice={handleNew}
      />
    </>
  );
}
