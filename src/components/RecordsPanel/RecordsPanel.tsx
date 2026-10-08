import { useMemo, useState, type ReactNode } from "react";
import { isSameLocalDay, matchesSearch, type DeviceRecord } from "../../domain/device";
import { RecordRow } from "./RecordRow";
import styles from "./RecordsPanel.module.css";

interface RecordsPanelProps {
  records: readonly DeviceRecord[];
  loaded: boolean;
  currentId: string;
  onOpen: (record: DeviceRecord) => void;
  onRestart: (record: DeviceRecord) => void;
}

export function RecordsPanel({ records, loaded, currentId, onOpen, onRestart }: RecordsPanelProps) {
  const [query, setQuery] = useState("");
  // Sem busca, só o que foi mexido hoje; digitando, procura em todos os aparelhos.
  const searching = query.trim() !== "";
  const visible = useMemo(
    () => (searching ? records.filter((r) => matchesSearch(r, query)) : records.filter((r) => isSameLocalDay(r.atualizado))),
    [records, query, searching],
  );

  let body: ReactNode;
  if (!loaded) body = <div className={styles.empty}>Carregando registros…</div>;
  else if (!visible.length)
    body = (
      <div className={styles.empty}>{searching ? "Nenhum registro encontrado." : "Nenhum aparelho hoje ainda."}</div>
    );
  else
    body = visible.map((record) => (
      <RecordRow
        key={record.id}
        record={record}
        isCurrent={record.id === currentId}
        onOpen={onOpen}
        onRestart={onRestart}
      />
    ));

  return (
    <section className={styles.panel} aria-label="Meus aparelhos">
      <div className={styles.header}>
        <h2>Meus aparelhos de hoje{loaded && !searching && ` · ${visible.length}`}</h2>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar em todos os dias: serial, modelo"
          aria-label="Buscar"
        />
      </div>
      {body}
    </section>
  );
}
