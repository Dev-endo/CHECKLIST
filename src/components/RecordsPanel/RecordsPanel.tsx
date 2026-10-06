import { useMemo, useState, type ReactNode } from "react";
import { matchesSearch, type DeviceRecord } from "../../domain/device";
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
  const visible = useMemo(() => records.filter((r) => matchesSearch(r, query)), [records, query]);

  let body: ReactNode;
  if (!loaded) body = <div className={styles.empty}>Carregando registros…</div>;
  else if (!visible.length)
    body = (
      <div className={styles.empty}>{records.length ? "Nenhum registro encontrado." : "Nenhum aparelho registrado ainda."}</div>
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
        <h2>Meus aparelhos</h2>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar serial, modelo ou técnico"
          aria-label="Buscar"
        />
      </div>
      {body}
    </section>
  );
}
