import { useEffect, useState, type ReactNode } from "react";
import { toDateInputValue, type DeviceRecord } from "../../domain/device";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { useReleasedIds } from "../../hooks/useReleasedIds";
import { fetchProfiles, type Profile } from "../../services/supabase/profilesService";
import { fetchReviewRecords, REVIEW_LIMIT, type ReviewFilters } from "../../services/supabase/reviewService";
import { AssetHistoryDialog } from "../AssetHistoryDialog/AssetHistoryDialog";
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

/** Abre mostrando só os checklists de hoje; o filtro de datas libera os outros dias. */
const todayFilters = (): ReviewFilters => {
  const today = toDateInputValue();
  return { from: today, to: today, userId: "", serial: "" };
};

/** Consulta, só leitura, dos checklists de todos os colaboradores. */
export function ReviewPanel({ client, onOpen }: ReviewPanelProps) {
  const [filters, setFilters] = useState<ReviewFilters>(todayFilters);
  const [serialInput, setSerialInput] = useState("");
  const [people, setPeople] = useState<Profile[]>([]);
  const [list, setList] = useState<ListState>({ records: [], total: 0, loaded: false, failed: false });
  const [reloads, setReloads] = useState(0);
  const [historySerial, setHistorySerial] = useState<string | null>(null);
  const releasedIds = useReleasedIds(client, list.records);

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

  const today = toDateInputValue();
  const onlyToday = filters.from === today && filters.to === today;
  const hasFilters = !onlyToday || Boolean(filters.userId || serialInput);
  const resetToToday = () => {
    setSerialInput("");
    setFilters(todayFilters());
  };
  const showAllDates = () => setFilters((prev) => ({ ...prev, from: "", to: "" }));

  let body: ReactNode;
  if (!list.loaded) body = <div className={recordStyles.empty}>Carregando checklists…</div>;
  else if (list.failed) body = <div className={recordStyles.empty}>Não foi possível carregar. Tente atualizar.</div>;
  else if (!list.records.length)
    body = (
      <div className={recordStyles.empty}>
        {onlyToday ? "Nenhum checklist hoje ainda. Mude as datas para ver outros dias." : "Nenhum checklist encontrado."}
      </div>
    );
  else
    body = (
      <>
        {list.records.map((record) => (
          <RecordRow
            key={record.id}
            record={record}
            isCurrent={false}
            onOpen={onOpen}
            showOwner
            released={releasedIds.has(record.id)}
            onHistory={(item) => setHistorySerial(item.serial ?? null)}
          />
        ))}
        {list.total > list.records.length && (
          <div className={recordStyles.empty}>Mostrando os {REVIEW_LIMIT} mais recentes. Refine os filtros.</div>
        )}
      </>
    );

  return (
    <section className={recordStyles.panel} aria-label="Registros de todos os colaboradores">
      <div className={recordStyles.header}>
        <h2>
          {onlyToday ? "Registros de hoje" : "Registros"}
          {list.loaded && !list.failed && ` · ${list.total} no total`}
        </h2>
        <div className={styles.actions}>
          {filters.from || filters.to ? (
            <Button variant="small" onClick={showAllDates}>
              Todas as datas
            </Button>
          ) : null}
          {hasFilters && (
            <Button variant="small" onClick={resetToToday}>
              Voltar para hoje
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
      <AssetHistoryDialog client={client} serial={historySerial} onClose={() => setHistorySerial(null)} />
    </section>
  );
}
