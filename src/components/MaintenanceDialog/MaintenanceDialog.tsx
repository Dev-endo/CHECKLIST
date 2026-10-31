import { useEffect, useRef, useState } from "react";
import {
  ANALYSIS_LABEL,
  AWAITING_PART_LABEL,
  DESTINATIONS,
  isMaintenanceComplete,
  MAINTENANCE_ITEMS,
  PLACA_ITEM,
  PLACA_SERVICES,
  setMaintenanceDetail,
  toggleMaintenance,
  type Destination,
  type Maintenance,
} from "../../domain/maintenance";
import { NON_PART_ITEMS, sortByCatalog, testPartBlocksConclusion, undecidedParts, type AllocationAction } from "../../domain/stock";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { requestPart, type PartLoan } from "../../services/supabase/stockService";
import { useDeviceStock } from "../../hooks/useDeviceStock";
import { Button } from "../Button/Button";
import { useToast } from "../Toast/ToastProvider";
import styles from "./MaintenanceDialog.module.css";

interface MaintenanceDialogProps {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (
    maintenances: Maintenance[],
    destination?: Destination,
    blocked?: boolean,
    resale?: boolean,
    note?: string,
    allocations?: { id: string; action: AllocationAction }[],
  ) => void;
  /** Com o cliente e o serial, o balão mostra as peças alocadas pelo estoque em vez de todas as manutenções. */
  client?: AppSupabaseClient;
  serial?: string;
  /** Face ID com defeito: o aparelho segue para a montagem e depois para laudo e revenda. */
  faceIdDefect?: boolean;
  /** Checklist reprovado: marca as manutenções feitas e, se quiser, envia para análise técnica. */
  rejected?: boolean;
}

const PT_OPTION = { id: "pt", label: "Enviar para PT" } as const;
const QUARANTINE_OPTION = { id: "quarentena", label: "Enviar para quarentena" } as const;
const AWAITING_OPTION = { id: "aguardando_peca", label: AWAITING_PART_LABEL } as const;

/** Escolha de um checklist com falha que segue sem destino: continua em manutenção. */
const STAYS = "continua";

/** Aparece ao concluir um checklist com tudo OK: quais manutenções foram feitas no aparelho. */
export function MaintenanceDialog({
  open,
  busy = false,
  onCancel,
  onConfirm,
  faceIdDefect = false,
  rejected = false,
  client,
  serial = "",
}: MaintenanceDialogProps) {
  const toast = useToast();
  const dialog = useRef<HTMLDialogElement>(null);
  const [choices, setChoices] = useState<Record<string, AllocationAction | undefined>>({});
  const [partDetail, setPartDetail] = useState("");
  const [asking, setAsking] = useState(false);
  const [selected, setSelected] = useState<Maintenance[]>([]);
  // Escolha explícita de que nenhuma manutenção foi executada.
  const [none, setNone] = useState(false);
  const [destination, setDestination] = useState<Destination | typeof STAYS | undefined>();
  // Ativo aberto e bloqueado: conta como bloqueado na análise (cada serial uma vez).
  const [blocked, setBlocked] = useState(false);
  // Aparelho vai para revenda? Sim leva direto para a montagem. Com Face ID com defeito já vem em Sim.
  const [resale, setResale] = useState<boolean | undefined>();
  // Aguardando peça: observação obrigatória (qual peça, previsão etc.).
  const [note, setNote] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setSelected([]);
      setChoices({});
      setPartDetail("");
      setNone(false);
      setBlocked(false);
      setNote("");
      setResale(faceIdDefect ? true : undefined);
      setDestination(undefined);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const key = serial.trim();
  // Peças alocadas ao aparelho na OS atual; o balão só mostra a lista completa de manutenções sem elas.
  const { stock, failed: stockFailed, refresh: refreshStock } = useDeviceStock(client, serial, open);

  // Com o banco ligado, só aparecem as manutenções das peças alocadas pelo estoque (e as que não usam peça).
  const partsMode = Boolean(client);
  const view = stock ?? { open: [], requests: [], loans: [] };
  // Peça de teste emprestada: o checklist só conclui depois que o estoquista libera a peça para uso ou confirma a devolução.
  const testPartOut = testPartBlocksConclusion(stock?.loans ?? []);
  const swapping = new Set((stock?.requests ?? []).flatMap((r) => (r.kind === "troca" && r.allocationId ? [r.allocationId] : [])));
  const waitingStock = (stock?.requests ?? []).some((r) => r.kind === "nova" || r.kind === "troca" || r.kind === "teste");

  const askLoan = async (loan: PartLoan, kind: "uso" | "devolucao") => {
    if (!client) return;
    setAsking(true);
    try {
      const result = await requestPart(client, { serial: key, part: loan.part, kind, loanId: loan.id });
      toast(result === "ok" ? "Pedido enviado ao estoquista" : "Esse pedido já foi enviado.");
      refreshStock();
    } catch {
      toast("Não foi possível enviar o pedido. Tente de novo.");
    } finally {
      setAsking(false);
    }
  };

  // Com falha no checklist: montagem, análise técnica ou continua em manutenção.
  // Com Face ID com defeito (uma recusa), "enviar para análise técnica" também é um destino.
  const destinations: readonly { id: Destination | typeof STAYS; label: string }[] = rejected
    ? [
        { id: "montagem", label: "Enviar para montagem" },
        { id: "vidro", label: "Enviado para vidro" },
        { id: "analise", label: ANALYSIS_LABEL },
        PT_OPTION,
        QUARANTINE_OPTION,
        AWAITING_OPTION,
        { id: STAYS, label: "Continua em manutenção" },
      ]
    : faceIdDefect
      ? [...DESTINATIONS, { id: "analise", label: ANALYSIS_LABEL }, PT_OPTION, QUARANTINE_OPTION, AWAITING_OPTION]
      : [...DESTINATIONS, PT_OPTION, QUARANTINE_OPTION, AWAITING_OPTION];
  // Revenda: o aparelho segue para a montagem automaticamente.
  const choice: Destination | typeof STAYS | undefined = resale ? "montagem" : destination;
  // Com peças alocadas, as manutenções são as peças concluídas (mais as avulsas, que não usam peça).
  const concluded: Maintenance[] = (stock?.open ?? [])
    .filter((part) => choices[part.id] === "concluir")
    .map((part) => (part.part === PLACA_ITEM && partDetail.trim() ? { item: part.part, detail: partDetail.trim() } : { item: part.part }));
  const maintenances = partsMode ? sortByCatalog([...concluded, ...selected]) : selected;
  const placa = partsMode ? concluded.find((m) => m.item === PLACA_ITEM) : selected.find((m) => m.item === PLACA_ITEM);
  const complete = isMaintenanceComplete(maintenances);
  // Ou marca as manutenções feitas, ou diz que nenhuma foi executada.
  const chosen = none || selected.length > 0;
  const undecided = undecidedParts(stock?.open ?? [], choices, swapping);

  let warn: string | null = null;
  if (!complete) warn = "Informe o serviço feito na placa para concluir.";
  else if (partsMode && !stock && !stockFailed) warn = "Aguarde carregar as peças alocadas pelo estoque.";
  else if (testPartOut)
    warn = "Peça de teste ainda emprestada: peça a liberação para uso ou devolva ao estoque. O checklist só conclui depois que o estoquista confirmar.";
  else if (partsMode && undecided.length) warn = `Decida cada peça alocada: concluir, devolver ou trocar (${undecided.map((p) => p.part).join(", ")}).`;
  else if (waitingStock) warn = "Há pedido de peça esperando o estoquista: o checklist só conclui depois que ele liberar a peça.";
  else if (!partsMode && !chosen) warn = 'Marque as manutenções feitas ou "Nenhuma manutenção executada".';
  else if (resale === undefined) warn = "Informe se o aparelho vai para revenda.";
  else if (!choice) warn = "Escolha para onde o aparelho vai.";
  else if (choice === "aguardando_peca" && !note.trim()) warn = "Escreva a observação do aguardando peça.";

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="maintenance-title"
      // Esc ou clique fora não concluem nada: só fecham a pergunta.
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="maintenance-title" className={styles.title}>
        Manutenções realizadas
      </h2>
      <p className={styles.help}>{rejected
          ? "Checklist com falha. Marque as manutenções feitas (ou nenhuma) e diga para onde o aparelho vai."
          : "Marque o que foi feito neste aparelho, ou marque que nenhuma manutenção foi executada."}</p>
      {faceIdDefect && (
        <p className={styles.notice}>
          Face ID com defeito: o aparelho não é reprovado. Ele segue para a montagem e depois para laudo e revenda, ou você pode enviá-lo para análise técnica.
        </p>
      )}

      {partsMode && (
        <>
          {stockFailed && (
            <p className={styles.notice}>Não foi possível consultar as peças do estoque. Feche e abra de novo; aqui só aparecem as manutenções que não usam peça.</p>
          )}
          {!stockFailed && !stock && <p className={styles.help}>Carregando as peças alocadas pelo estoque…</p>}
          {stock && view.open.length === 0 && view.loans.length === 0 && view.requests.length === 0 && (
            <p className={styles.help}>Nenhuma peça alocada pelo estoque neste aparelho.</p>
          )}
          {view.loans.length > 0 && (
            <p className={styles.notice}>
              Este aparelho tem peça de teste alocada. Solicite a liberação ao estoquista para usá-la, ou devolva ao estoque: o checklist só conclui depois disso.
            </p>
          )}
          <p className={styles.help}>Peças alocadas pelo estoque neste aparelho. Diga o que aconteceu com cada uma. Para trocar peça ou pedir outra, use "Peças do aparelho" na tela do checklist.</p>
          {view.open.map((part) => {
            const waiting = swapping.has(part.id);
            return (
              <fieldset key={part.id} className={styles.destination} disabled={busy || asking}>
                <legend>{part.part}</legend>
                {waiting ? (
                  <span className={styles.help}>Troca solicitada: aguardando o estoquista.</span>
                ) : (
                  <>
                    {(["concluir", "devolver"] as const).map((action) => (
                      <label key={action} className={styles.option}>
                        <input
                          type="radio"
                          name={`part-${part.id}`}
                          checked={choices[part.id] === action}
                          onChange={() => setChoices((prev) => ({ ...prev, [part.id]: action }))}
                        />
                        <span>{action === "concluir" ? "Concluir (peça usada)" : "Devolver (não precisou)"}</span>
                      </label>
                    ))}
                  </>
                )}
              </fieldset>
            );
          })}
          {view.loans.map((loan) => {
            const pending = view.requests.filter((r) => r.loanId === loan.id);
            const waitingUse = pending.some((r) => r.kind === "uso");
            const waitingReturn = pending.some((r) => r.kind === "devolucao");
            return (
              <fieldset key={loan.id} className={styles.destination} disabled={busy || asking}>
                <legend>Peça de teste: {loan.part}</legend>
                {waitingUse || waitingReturn ? (
                  <span className={styles.help}>
                    {waitingUse ? "Liberação para uso pedida" : "Devolução informada"}: aguardando o estoquista.
                  </span>
                ) : (
                  <>
                    <Button variant="small" onClick={() => void askLoan(loan, "uso")}>
                      Solicitar liberação para uso
                    </Button>
                    <Button variant="small" onClick={() => void askLoan(loan, "devolucao")}>
                      Devolver ao estoque
                    </Button>
                  </>
                )}
              </fieldset>
            );
          })}
          {view.requests
            .filter((r) => r.kind === "nova" || r.kind === "teste")
            .map((r) => (
              <p key={r.id} className={styles.notice}>
                {r.kind === "teste" ? "Peça para teste" : "Nova peça"} solicitada ({r.part}): aguardando o estoquista.
              </p>
            ))}
          <p className={styles.help}>Outras manutenções que não usam peça:</p>
          <div className={styles.grid}>
            {NON_PART_ITEMS.map((item) => (
              <label key={item} className={styles.option}>
                <input
                  type="checkbox"
                  checked={selected.some((m) => m.item === item)}
                  disabled={busy}
                  onChange={() => setSelected((prev) => toggleMaintenance(prev, item))}
                />
                <span>{item}</span>
              </label>
            ))}
          </div>
        </>
      )}

      {!partsMode && (
        <>
      <label className={[styles.option, styles.none].join(" ")}>
        <input
          type="checkbox"
          checked={none}
          disabled={busy}
          onChange={(e) => {
            setNone(e.target.checked);
            if (e.target.checked) setSelected([]);
          }}
        />
        <span>Nenhuma manutenção executada</span>
      </label>

      <div className={styles.grid}>
        {MAINTENANCE_ITEMS.map((item) => (
          <label key={item} className={styles.option}>
            <input
              type="checkbox"
              checked={selected.some((m) => m.item === item)}
              disabled={busy}
              onChange={() => {
                setNone(false);
                setSelected((prev) => toggleMaintenance(prev, item));
              }}
            />
            <span>{item}</span>
          </label>
        ))}
      </div>

        </>
      )}

      {placa && (
        <label className={styles.detail}>
          Qual manutenção foi feita na placa?
          {PLACA_SERVICES.length ? (
            <select
              value={placa.detail ?? ""}
              disabled={busy}
              onChange={(e) =>
                partsMode ? setPartDetail(e.target.value) : setSelected((prev) => setMaintenanceDetail(prev, PLACA_ITEM, e.target.value))
              }
            >
              <option value="">Selecione…</option>
              {PLACA_SERVICES.map((service) => (
                <option key={service} value={service}>
                  {service}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={placa.detail ?? ""}
              maxLength={120}
              disabled={busy}
              placeholder="Descreva o serviço feito na placa"
              onChange={(e) =>
                partsMode ? setPartDetail(e.target.value) : setSelected((prev) => setMaintenanceDetail(prev, PLACA_ITEM, e.target.value))
              }
            />
          )}
        </label>
      )}

      <label className={[styles.option, styles.none].join(" ")}>
        <input type="checkbox" checked={blocked} disabled={busy} onChange={(e) => setBlocked(e.target.checked)} />
        <span>Ativo bloqueado</span>
      </label>

      <fieldset className={styles.destination} disabled={busy}>
        <legend>Aparelho vai para revenda?</legend>
        {[
          { label: "Sim", value: true },
          { label: "Não", value: false },
        ].map((option) => (
          <label key={option.label} className={styles.option}>
            <input type="radio" name="resale" checked={resale === option.value} onChange={() => setResale(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      {resale && <p className={styles.help}>Revenda: o aparelho segue para a montagem automaticamente.</p>}
      <fieldset className={styles.destination} disabled={busy || Boolean(resale)}>
        <legend>Para onde o aparelho vai?</legend>
        {destinations.map(({ id, label }) => (
          <label key={id} className={styles.option}>
            <input type="radio" name="destination" checked={choice === id} onChange={() => setDestination(id)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      {choice === "aguardando_peca" && (
        <label className={styles.detail}>
          Observação (qual peça está aguardando)
          <textarea value={note} maxLength={500} rows={2} disabled={busy} onChange={(e) => setNote(e.target.value)} />
        </label>
      )}
      {!rejected && (
        <p className={styles.help}>
          Só "Liberado para montagem" tira o aparelho da manutenção. Enviado para vidro ou para análise técnica, ele continua em manutenção.
        </p>
      )}

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
        <Button
          onClick={() =>
            onConfirm(
              maintenances,
              choice === STAYS ? undefined : choice,
              blocked,
              resale,
              choice === "aguardando_peca" ? note.trim() : undefined,
              partsMode
                ? (stock?.open ?? []).flatMap((part) => {
                    const action = choices[part.id];
                    return action ? [{ id: part.id, action }] : [];
                  })
                : undefined,
            )
          }
          disabled={busy || Boolean(warn)}
        >
          {busy ? "Concluindo…" : "Concluir checklist"}
        </Button>
      </div>
      {warn && <p className={styles.warn}>{warn}</p>}
    </dialog>
  );
}
