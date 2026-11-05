import { useEffect, useState } from "react";
import { toDateInputValue } from "../../domain/device";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  fetchProductivity,
  fetchProductivityDevices,
  type Productivity,
  type ProductivityDevice,
} from "../../services/supabase/dashboardService";
import { Button } from "../Button/Button";
import styles from "./Productivity.module.css";
import dashStyles from "./Dashboard.module.css";

const DESTINOS: Record<string, string> = {
  quarentena: "Quarentena",
  vidro: "Vidro",
  analise: "Análise técnica",
  revenda: "Revenda",
  pt: "PT (aprovação pendente)",
  bloqueado: "Bloqueado",
};

const hour = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const shift = (day: string, days: number) => {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + days);
  return toDateInputValue(date);
};

/**
 * Análise > Produtividade individual: num dia, cada técnico com "Meta batida" ou "Meta não batida" (6 liberados
 * para a quarentena e o vidro). Clicando: a justificativa, as manutenções e os aparelhos que ele fez.
 */
export function ProductivityView({ client, initialDay }: { client: AppSupabaseClient; initialDay: string }) {
  const [day, setDay] = useState(initialDay || toDateInputValue());
  const [rows, setRows] = useState<Productivity[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [devices, setDevices] = useState<ProductivityDevice[] | null>(null);
  const today = toDateInputValue();
  const isToday = day === today;

  useEffect(() => {
    setRows(null);
    setFailed(false);
    if (!day) return;
    let active = true;
    fetchProductivity(client, day)
      .then((found) => active && setRows(found))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client, day]);

  useEffect(() => {
    setDevices(null);
    if (!open || !day) return;
    let active = true;
    fetchProductivityDevices(client, open, day)
      .then((found) => active && setDevices(found))
      .catch(() => active && setDevices([]));
    return () => {
      active = false;
    };
  }, [client, open, day]);

  const hit = rows?.filter((row) => row.batida).length ?? 0;

  return (
    <section aria-label="Produtividade individual">
      <div className={styles.dayBar}>
        <Button variant="small" onClick={() => setDay(shift(day, -1))}>
          ← Dia anterior
        </Button>
        <label>
          Dia
          <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} />
        </label>
        <Button variant="small" disabled={day >= today} onClick={() => setDay(shift(day, 1))}>
          Próximo dia →
        </Button>
        {!isToday && (
          <Button variant="ghost" onClick={() => setDay(today)}>
            Hoje
          </Button>
        )}
      </div>
      <p className={dashStyles.muted}>
        Meta: 6 aparelhos liberados no dia para a quarentena e para o vidro. Clique no técnico para ver o motivo, as manutenções e os aparelhos.
        {isToday ? " Hoje o dia ainda não terminou: os números continuam mudando." : ""}
      </p>

      {failed && <p className={dashStyles.warn}>Não foi possível carregar. Rode a migration 84 no Supabase ou tente de novo.</p>}
      {!failed && rows === null && <p className={dashStyles.muted}>Carregando…</p>}
      {rows?.length === 0 && <p className={dashStyles.muted}>Nenhum técnico no dia.</p>}
      {rows && rows.length > 0 && (
        <p className={styles.summary}>
          <strong>{hit}</strong> de {rows.length} técnico(s) bateram a meta.
        </p>
      )}

      <ul className={styles.list}>
        {rows?.map((row) => {
          const expanded = open === row.userId;
          return (
            <li key={row.userId} className={[styles.item, row.batida ? styles.hit : styles.miss].join(" ")}>
              <button type="button" className={styles.head} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : row.userId)}>
                <span className={[styles.badge, row.batida ? styles.badgeHit : styles.badgeMiss].join(" ")}>
                  {row.batida ? "✓ Meta batida" : isToday ? "Meta não batida (até agora)" : "✗ Meta não batida"}
                </span>
                <strong className={styles.name}>{row.name}</strong>
                <span className={styles.numbers}>
                  {row.liberados}/{row.meta} liberados · {row.manutencoes} manutenção(ões)
                </span>
                {!row.batida && !row.justificativa && !isToday && <span className={styles.noNote}>sem justificativa</span>}
                <span className={styles.chevron} aria-hidden="true">
                  {expanded ? "▲" : "▼"}
                </span>
              </button>

              {expanded && (
                <div className={styles.body}>
                  {!row.batida && (
                    <div className={styles.note}>
                      <span className={styles.label}>Motivo de não bater a meta</span>
                      <p>{row.justificativa ?? (isToday ? "Ainda não justificou." : "O técnico não justificou.")}</p>
                    </div>
                  )}

                  <dl className={styles.stats}>
                    <div>
                      <dt>Liberados</dt>
                      <dd>
                        {row.liberados} <small>({row.quarentena} quarentena · {row.vidro} vidro)</small>
                      </dd>
                    </div>
                    <div>
                      <dt>Manutenções</dt>
                      <dd>{row.manutencoes}</dd>
                    </div>
                    <div>
                      <dt>Aparelhos finalizados</dt>
                      <dd>{row.aparelhos}</dd>
                    </div>
                    <div>
                      <dt>Peças entregues</dt>
                      <dd>{row.entregues}</dd>
                    </div>
                    <div>
                      <dt>Testes devolvidos</dt>
                      <dd>{row.devolvidas}</dd>
                    </div>
                    <div>
                      <dt>Substituídas por defeito</dt>
                      <dd>{row.substituidas}</dd>
                    </div>
                    <div>
                      <dt>Testes usados de vez</dt>
                      <dd>{row.testesUsados}</dd>
                    </div>
                  </dl>

                  <h3 className={styles.subheading}>Aparelhos feitos no dia</h3>
                  {devices === null && <p className={dashStyles.muted}>Carregando…</p>}
                  {devices?.length === 0 && <p className={dashStyles.muted}>Nenhum aparelho no dia.</p>}
                  {devices && devices.length > 0 && (
                    <div className={dashStyles.tableWrap}>
                      <table className={dashStyles.table}>
                        <thead>
                          <tr>
                            <th>Hora</th>
                            <th>Serial</th>
                            <th>Modelo</th>
                            <th>Unit ID</th>
                            <th>OS</th>
                            <th>Onde</th>
                            <th>Destino</th>
                            <th>Manutenções</th>
                          </tr>
                        </thead>
                        <tbody>
                          {devices.map((device, i) => (
                            <tr key={`${device.serial}-${device.at}-${i}`}>
                              <td>{hour(device.at)}</td>
                              <td className={styles.mono}>{device.serial}</td>
                              <td>{device.model ?? "—"}</td>
                              <td>{device.unit ?? "—"}</td>
                              <td>{device.osNumber ?? "—"}</td>
                              <td>{device.origem}</td>
                              <td>
                                {device.destino ? DESTINOS[device.destino] ?? device.destino : "—"}
                                {device.contaMeta ? " ✓" : ""}
                              </td>
                              <td>{device.manutencoes}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className={dashStyles.muted}>✓ = conta para a meta (quarentena ou vidro).</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
