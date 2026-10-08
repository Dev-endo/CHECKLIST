import { useEffect, useState, type ReactNode } from "react";
import type { DeviceRecord } from "../../domain/device";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchProfiles, type Profile } from "../../services/supabase/profilesService";
import { fetchReviewRecords, REVIEW_LIMIT, type ReviewFilters } from "../../services/supabase/reviewService";
import { Button } from "../Button/Button";
import { RecordRow } from "../RecordsPanel/RecordRow";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import styles from "./ReviewPanel.module.css";

interface ReviewPanelProps {
  client: AppSupabaseClient;
  onOpen: (record: DeviceRecord) => void;
}

interface ListState {
  records: DeviceRecord[];
  total: number;
  loaded: boolean;
  failed: boolean;
}

const SERIAL_DEBOUNCE_MS = 300;

/** Consulta, só leitura, dos checklists de todos os colaboradores. */
export function ReviewPanel({ client, onOpen }: ReviewPanelProps) {
  const [filters, setFilters] = useState<ReviewFilters>({ from: "", to: "", userId: "", serial: "" });
  const [serialInput, setSerialInput] = useState("");
  const [people, setPeople] = useState<Profile[]>([]);
  const [list, setList] = useState<ListState>({ records: [], total: 0, loaded: false, failed: false });
  const [reloads, setReloads] = useState(0);

  const setFilter = (key: "from" | "to" | "userId", value: string) => setFilters((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    let active = true;
    fetchProfiles(client)
      .then((profiles) => active && setPeople(profiles))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    const timer = setTimeout(() => setFilters((prev) => ({ ...prev, serial: serialInput })), SERIAL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [serialInput]);

  useEffect(() => {
    let active = true;
    setList((prev) => ({ ...prev, loaded: false, failed: false }));
    fetchReviewRecords(client, filters)
      .then(({ records, total }) => active && setList({ records, total, loaded: true, failed: false }))
      .catch(() => active && setList({ records: [], total: 0, loaded: true, failed: true }));
    return () => {
      active = false;
    };
  }, [client, filters, reloads]);

  const hasFilters = Boolean(filters.from || filters.to || filters.userId || serialInput);
  const clear = () => {
    setSerialInput("");
    setFilters({ from: "", to: "", userId: "", serial: "" });
  };

  let body: ReactNode;
  if (!list.loaded) body = <div className={recordStyles.empty}>Carregando checklists…</div>;
  else if (list.failed) body = <div className={recordStyles.empty}>Não foi possível carregar. Tente atualizar.</div>;
  else if (!list.records.length) body = <div className={recordStyles.empty}>Nenhum checklist encontrado.</div>;
  else
    body = (
      <>
        {list.records.map((record) => (
          <RecordRow key={record.id} record={record} isCurrent={false} onOpen={onOpen} showOwner />
        ))}
        {list.total > list.records.length && (
          <div className={recordStyles.empty}>Mostrando os {REVIEW_LIMIT} mais recentes. Refine os filtros.</div>
        )}
      </>
    );

  return (
    <section className={recordStyles.panel} aria-label="Registros de todos os colaboradores">
      <div className={recordStyles.header}>
        <h2>Registros{list.loaded && !list.failed && ` · ${list.total} no total`}</h2>
        <div className={styles.actions}>
          {hasFilters && (
            <Button variant="small" onClick={clear}>
              Limpar filtros
            </Button>
          )}
          <Button variant="small" onClick={() => setReloads((n) => n + 1)}>
            Atualizar
          </Button>
        </div>
      </div>
      <div className={styles.filters}>
        <label className={styles.field}>
          De
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter("from", e.target.value)} />
        </label>
        <label className={styles.field}>
          Até
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter("to", e.target.value)} />
        </label>
        <label className={styles.field}>
          Colaborador
          <select value={filters.userId} onChange={(e) => setFilter("userId", e.target.value)}>
            <option value="">Todos</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name || person.email}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          Serial
          <input value={serialInput} placeholder="Serial" onChange={(e) => setSerialInput(e.target.value)} />
        </label>
      </div>
      {body}
    </section>
  );
}
