import { useEffect, useRef, useState } from "react";
import { parseAssetsCsv, type ParsedAssets } from "../../domain/csv";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { countAssets, importAssets, type ImportSummary } from "../../services/supabase/assetsService";
import { Button } from "../Button/Button";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import styles from "./AssetImport.module.css";

interface AssetImportProps {
  client: AppSupabaseClient;
}

const fmt = (n: number) => n.toLocaleString("pt-BR");

/** Admin: sobe o CSV da planilha de ativos; só entram os seriais que ainda não existem. */
export function AssetImport({ client }: AssetImportProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedAssets | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadTotal = () => countAssets(client).then(setTotal, () => undefined);
  useEffect(() => {
    void reloadTotal();
  }, [client]);

  const importing = sent !== null;

  const handleFile = async (file: File | undefined) => {
    setSummary(null);
    setError(null);
    setParsed(null);
    if (!file) return;
    setFileName(file.name);
    setParsed(parseAssetsCsv(await file.text()));
  };

  const reset = () => {
    setParsed(null);
    setFileName("");
    if (fileInput.current) fileInput.current.value = "";
  };

  const handleImport = async () => {
    if (!parsed?.rows.length) return;
    setError(null);
    setSent(0);
    try {
      setSummary(await importAssets(client, parsed.rows, setSent));
      reset();
    } catch {
      setError("Não foi possível importar. Confira se você é administrador e tente de novo.");
    } finally {
      setSent(null);
      void reloadTotal();
    }
  };

  return (
    <section className={recordStyles.panel} aria-label="Importar ativos">
      <div className={recordStyles.header}>
        <h2>Ativos (serial e unit id){total !== null && ` · ${fmt(total)} cadastrados`}</h2>
      </div>
      <div className={styles.body}>
        <p className={styles.note}>
          Suba o CSV exportado da planilha, com as colunas <b>asset_short_id</b> e <b>serial</b>. Só entram os seriais
          que ainda não existem; o que já está cadastrado não é copiado nem alterado. Pode subir a planilha completa
          todo dia.
        </p>

        <div className={styles.pick}>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            disabled={importing}
            aria-label="Arquivo CSV de ativos"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
        </div>

        {parsed?.error && (
          <p className={styles.error} role="alert">
            {parsed.error}
          </p>
        )}

        {parsed && !parsed.error && (
          <div className={styles.preview}>
            <span>
              <b>{fileName}</b>: {fmt(parsed.rows.length)} linhas válidas
              {parsed.invalid > 0 && `, ${fmt(parsed.invalid)} ignoradas (sem serial ou sem asset_short_id)`}.
            </span>
            <div className={styles.actions}>
              <Button onClick={() => void handleImport()} disabled={importing || !parsed.rows.length}>
                {importing ? `Importando… ${fmt(sent)} / ${fmt(parsed.rows.length)}` : "Importar novos ativos"}
              </Button>
              <Button variant="ghost" onClick={reset} disabled={importing}>
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        {summary && (
          <p className={styles.result} role="status">
            Importação concluída: <b>{fmt(summary.inserted)} novos</b>, {fmt(summary.existing)} já existiam
            {summary.conflicts > 0 &&
              `, ${fmt(summary.conflicts)} em conflito (o serial ou o asset_short_id já existe ligado a outro; não foram alterados)`}
            .
          </p>
        )}
      </div>
    </section>
  );
}
