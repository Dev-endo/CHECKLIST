import { useEffect, useRef } from "react";
import styles from "./ReportFallback.module.css";

/** Mostra o laudo selecionado quando a área de transferência não está disponível. */
export function ReportFallback({ text }: { text: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.select();
  }, [text]);

  return <textarea ref={ref} className={styles.report} value={text} readOnly aria-label="Laudo" />;
}
