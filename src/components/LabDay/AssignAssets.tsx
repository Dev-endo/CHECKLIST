import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { parseSerials, PROBLEM_LABELS, LAB_STATUS_LABELS, previewRows, validSerials, type SerialCheck } from "../../domain/labDay";
import { describeRepairError } from "../../domain/repairStages";
import type { AppSupabaseClient } from "../../services/supabase/client";
import {
  deliverAssets,
  directFromGlass,
  fetchBalloonReport,
  listLabTechnicians,
  previewSerials,
  reassignAssets,
  type LabTechnician,
} from "../../services/supabase/labDayService";
import { Button } from "../Button/Button";
import styles from "./LabDay.module.css";

const LOOKUP_DEBOUNCE_MS = 350;

interface AssignAssetsProps {
  client: AppSupabaseClient;
  /** entrega: o supervisor vincula qualquer ativo (o do Vidro é direcionado); vidro: só ativos com status Vidro. */
  mode: "entrega" | "vidro";
  /** Avisa quem usa que algo mudou (ex.: recarregar a lista do Vidro). */
  onDone?: () => void;
  /** Seriais já colocados na caixa (ex.: o botão "Direcionar" de um serviço de vidro). */
  initialSerials?: readonly string[];
}

/**
 * Duas caixas do mesmo tamanho: "Bipar ativos aqui" (o leitor manda o serial + Enter; também aceita colar vários) e
 * "Selecione o técnico responsável" (só técnicos). Abaixo, a lista prévia com o Unit ID, o contador e os avisos.
 */
export function AssignAssets({ client, mode, onDone, initialSerials }: AssignAssetsProps) {
  const glass = mode === "vidro";
  const [text, setText] = useState(initialSerials?.length ? `${initialSerials.join("\n")}\n` : "");
  const [checks, setChecks] = useState<Map<string, SerialCheck>>(new Map());
  const [looking, setLooking] = useState(false);
  const { user } = useAuth();
  const myId = user?.id ?? "";
  const [technicians, setTechnicians] = useState<LabTechnician[] | null>(null);
  const [technicianId, setTechnicianId] = useState("");
  const [display, setDisplay] = useState(false);
  // Corrigir o técnico dos já vinculados a outro (só na Entrega).
  const [reassign, setReassign] = useState(false);
  // Entrega: quantos ativos o técnico escolhido já tem (na bancada e aguardando confirmação de transferência).
  const [bench, setBench] = useState<{ technicianId: string; open: number; pending: number } | null>(null);
  const [benchReloads, setBenchReloads] = useState(0);
  useEffect(() => {
    setBench(null);
    if (glass || !technicianId) return;
    let active = true;
    const now = new Date();
    fetchBalloonReport(client, now, new Date(now.getTime() + 1000))
      .then((found) => {
        if (!active) return;
        const mine = found.filter((item) => item.technicianId === technicianId);
        setBench({
          technicianId,
          open: mine.filter((item) => item.status === "aberto").length,
          pending: mine.filter((item) => item.status === "pendente").length,
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, glass, technicianId, benchReloads]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listLabTechnicians(client)
      // Quem está logado aparece primeiro (dá para vincular a si mesmo); o resto em ordem alfabética.
      .then(
        (found) =>
          active &&
          setTechnicians(
            [...found].sort((a, b) => Number(b.id === myId) - Number(a.id === myId) || a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" })),
          ),
      )
      .catch(() => active && setTechnicians([]));
    return () => {
      active = false;
    };
  }, [client, myId]);

  const serials = useMemo(() => parseSerials(text), [text]);
  const lookupKey = serials.join("\n");

  // Busca o Unit ID e onde cada ativo está, pouco depois de parar de bipar.
  useEffect(() => {
    if (!serials.length) {
      setChecks(new Map());
      return;
    }
    let active = true;
    setLooking(true);
    const timer = setTimeout(() => {
      previewSerials(client, serials)
        .then((found) => active && setChecks(found))
        .catch((e) => active && setError(describeRepairError(e as { message?: string }, "Não foi possível buscar os seriais.")))
        .finally(() => active && setLooking(false));
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, lookupKey]);

  const rows = previewRows(serials, checks, glass);
  const ready = validSerials(rows);
  const technician = technicians?.find((item) => item.id === technicianId);
  // Já vinculados a outro técnico (sem repetir): na Entrega dá para trocar o técnico deles.
  const taken = glass ? [] : rows.filter((row) => row.problem === "com_tecnico");
  const toMove = reassign ? taken.filter((row) => row.holder !== technician?.name).map((row) => row.serial) : [];
  const warnings = rows.filter((row) => row.problem && !(reassign && row.problem === "com_tecnico")).length;
  const total = ready.length + toMove.length;

  const remove = (index: number) => {
    const next = serials.filter((_, i) => i !== index);
    setText(next.length ? `${next.join("\n")}\n` : "");
  };

  const submit = async () => {
    if (!total || !technician || busy) return;
    if (warnings && !window.confirm(`${warnings} serial(is) com aviso ficam de fora. Seguir com os outros ${total}?`)) return;
    if (toMove.length && !window.confirm(`Trocar para ${technician.name} o técnico de ${toMove.length} ativo(s) já vinculado(s)? O checklist em andamento vai junto.`)) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const parts: string[] = [];
      if (ready.length) {
        const count = glass ? await directFromGlass(client, ready, technician.id, display) : await deliverAssets(client, ready, technician.id);
        parts.push(`${count} ${count === 1 ? "ativo" : "ativos"} ${glass ? (count === 1 ? "direcionado" : "direcionados") : count === 1 ? "vinculado" : "vinculados"}`);
      }
      if (toMove.length) {
        const moved = (await reassignAssets(client, toMove, technician.id)).filter((item) => item.ok).length;
        parts.push(`${moved} com o técnico trocado`);
      }
      setDone(`${parts.join(" e ")} para ${technician.name}.`);
      setText("");
      setDisplay(false);
      setReassign(false);
      setBenchReloads((n) => n + 1);
      onDone?.();
    } catch (e) {
      const err = e as { message?: string; details?: string };
      const message = describeRepairError(err, "Não foi possível vincular os ativos.");
      setError(err.details ? `${message} (${err.details})` : message);
      // Relê a prévia: alguém pode ter vinculado o ativo nesse meio-tempo.
      previewSerials(client, serials).then(setChecks).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={glass ? "Direcionar para técnico" : "Entrega de ativos"}>
      <div className={styles.boxes}>
        <div className={styles.box}>
          <label className={styles.boxTitle} htmlFor={`lab-serials-${mode}`}>
            Bipar ativos aqui
          </label>
          <span className={styles.muted}>
            {glass
              ? "Só ativos com status Vidro. Bipe um a um ou cole vários (quebra de linha, vírgula, ponto e vírgula ou espaço)."
              : "Bipe um a um (o leitor manda o serial + Enter) ou cole vários (quebra de linha, vírgula, ponto e vírgula ou espaço)."}
          </span>
          <textarea
            id={`lab-serials-${mode}`}
            value={text}
            autoFocus={!glass}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            placeholder={"Serial 1\nSerial 2\n…"}
            onChange={(e) => {
              setText(e.target.value);
              setDone(null);
              setError(null);
            }}
          />
        </div>

        <div className={styles.box}>
          <h2 className={styles.boxTitle}>Selecione o técnico responsável</h2>
          {technicians === null && <span className={styles.muted}>Carregando…</span>}
          {technicians?.length === 0 && <span className={styles.muted}>Nenhum técnico cadastrado.</span>}
          <ul className={styles.techList} role="radiogroup" aria-label="Técnico responsável">
            {technicians?.map((item) => (
              <li key={item.id}>
                <label className={styles.tech}>
                  <input
                    type="radio"
                    name={`lab-tech-${mode}`}
                    value={item.id}
                    checked={technicianId === item.id}
                    disabled={busy}
                    onChange={() => setTechnicianId(item.id)}
                  />
                  <span className={styles.techName}>
                    {item.name}
                    {item.id === myId ? " (você)" : ""}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {!glass && technician && (
            <p className={styles.benchNote} role="status" aria-live="polite">
              {bench?.technicianId !== technician.id
                ? "Contando os ativos do técnico…"
                : `${technician.id === myId ? "Você já tem" : `${technician.name} já tem`} ${bench.open} ${bench.open === 1 ? "ativo" : "ativos"} na bancada${
                    bench.pending ? ` + ${bench.pending} aguardando confirmação de transferência` : ""
                  }.`}
            </p>
          )}
        </div>
      </div>

      {serials.length > 0 && (
        <div className={styles.preview} aria-live="polite">
          <div className={styles.previewHead}>
            <strong>
              {serials.length} {serials.length === 1 ? "serial lido" : "seriais lidos"}
            </strong>
            <span className={styles.muted}>
              {ready.length} pronto(s) para {glass ? "direcionar" : "vincular"}
              {warnings ? ` · ${warnings} com aviso` : ""}
              {looking ? " · buscando…" : ""}
            </span>
          </div>
          <ul className={styles.previewList}>
            {rows.map((row, index) => (
              <li key={`${row.serial}-${index}`} className={styles.previewItem}>
                <span className={styles.mono}>{row.serial}</span>
                <span>{row.unit ?? "—"}</span>
                {row.problem ? (
                  <span className={[styles.tag, styles.tagWarn].join(" ")}>
                    {PROBLEM_LABELS[row.problem]}
                    {row.problem === "com_tecnico" && row.holder ? `: ${row.holder}` : ""}
                  </span>
                ) : (
                  <span className={styles.muted}>
                    {row.labStatus === "vidro" && !glass
                      ? "No Vidro: será direcionado"
                      : row.labStatus === "reprovado_aguardando"
                        ? "Reprovado na quarentena: será redistribuído"
                        : row.labStatus
                          ? LAB_STATUS_LABELS[row.labStatus]
                          : looking && !checks.size
                            ? "…"
                            : "OK"}
                  </span>
                )}
                <Button variant="ghost" disabled={busy} onClick={() => remove(index)} aria-label={`Remover ${row.serial}`}>
                  Remover
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {taken.length > 0 && (
        <label className={styles.checkRow}>
          <input type="checkbox" checked={reassign} disabled={busy} onChange={(e) => setReassign(e.target.checked)} />
          <span>
            <strong>Trocar o técnico</strong> dos {taken.length} já vinculado(s) a outro técnico para o técnico escolhido (correção de erro)
          </span>
        </label>
      )}

      {glass && (
        <label className={styles.checkRow}>
          <input type="checkbox" checked={display} disabled={busy} onChange={(e) => setDisplay(e.target.checked)} />
          Solicitar troca de display (aviso para o técnico)
        </label>
      )}

      <div className={styles.actions}>
        <Button disabled={busy || looking || !total || !technician} onClick={() => void submit()}>
          {busy ? "Enviando…" : glass ? "Direcionar para técnico" : toMove.length && !ready.length ? "Trocar técnico" : "Vincular ativos"}
          {total ? ` (${total})` : ""}
        </Button>
        {!technician && (ready.length > 0 || taken.length > 0) && <span className={styles.muted}>Escolha o técnico.</span>}
        {text && (
          <Button variant="ghost" disabled={busy} onClick={() => setText("")}>
            Limpar
          </Button>
        )}
      </div>
      {done && (
        <p className={styles.success} role="status">
          ✓ {done}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
