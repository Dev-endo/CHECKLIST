import { useState } from "react";
import type { DeviceRecord } from "../../domain/device";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { AnalysisPanel } from "../AnalysisPanel/AnalysisPanel";
import { ReviewPanel } from "../ReviewPanel/ReviewPanel";
import styles from "./ReviewSection.module.css";

interface ReviewSectionProps {
  client: AppSupabaseClient;
  onOpen: (record: DeviceRecord) => void;
}

type View = "lista" | "analise";

const VIEWS: { id: View; label: string }[] = [
  { id: "lista", label: "Checklists" },
  { id: "analise", label: "Análise" },
];

/** Aba Registros: a lista de checklists e a análise de manutenções. */
export function ReviewSection({ client, onOpen }: ReviewSectionProps) {
  const [view, setView] = useState<View>("lista");

  return (
    <>
      <nav className={styles.tabs} aria-label="Registros">
        {VIEWS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={styles.tab}
            aria-current={view === id ? "page" : undefined}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {view === "lista" ? <ReviewPanel client={client} onOpen={onOpen} /> : <AnalysisPanel client={client} />}
    </>
  );
}
