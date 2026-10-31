import { useEffect, useRef, useState } from "react";
import { splitAssetId } from "../../domain/device";
import { ALLOCATION_LABELS, openParts } from "../../domain/stock";
import { lookupAsset, type Asset } from "../../services/supabase/assetsService";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchSwappedParts } from "../../services/supabase/analysisSearchService";
import { fetchAssetOrders, type ServiceOrder } from "../../services/supabase/serviceOrderService";
import {
  allocatePart,
  fetchAwaitingAllocation,
  fetchBorrowers,
  fetchOpenAllocations,
  fetchSerialAllocations,
  fetchSerialLoans,
  lendTestPart,
  type AllocateResult,
  type AwaitingDevice,
  type OpenAllocation,
  type Borrower,
  type PartAllocation,
  type PartLoan,
} from "../../services/supabase/stockService";
import { formatDateTime } from "../../utils/format";
import { Button } from "../Button/Button";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import serviceStyles from "../ServiceOrderPanel/ServiceOrderPanel.module.css";
import { useToast } from "../Toast/ToastProvider";
import { LendTestDialog } from "./LendTestDialog";
import { RequestCard } from "../StockAlerts/RequestCard";
import { useStockRequests } from "../StockAlerts/StockRequests";
import { AllocatedParts } from "./AllocatedParts";
import { SwappedParts, today } from "./SwappedParts";
import { OverviewDialog } from "./OverviewDialog";
import overviewStyles from "./OverviewDialog.module.css";
import { PartPickerDialog } from "./PartPickerDialog";
import styles from "./StockPanel.module.css";

interface StockPanelProps {
  client: AppSupabaseClient;
}

const LOOKUP_DEBOUNCE_MS = 250;

/**
 * Aba Estoque: o estoquista bipa o serial (só o modelo aparece) e escolhe as peças a alocar na OS atual do aparelho.
 * A OS é registrada pelo desmontador; cada passagem do aparelho pelo laboratório tem uma OS nova.
 */
export function StockPanel({ client }: StockPanelProps) {
  const toast = useToast();
  const { items: requests, busyId, decide } = useStockRequests();
  const [allocated, setAllocated] = useState<OpenAllocation[] | null>(null);
  // Balão aberto pela visão geral (pedidos, peças alocadas ou aparelhos aguardando).
  const [swappedToday, setSwappedToday] = useState<number | null>(null);
  const [balloon, setBalloon] = useState<"requests" | "allocated" | "awaiting" | "swapped" | null>(null);
  const serialInput = useRef<HTMLInputElement>(null);
  const [serial, setSerial] = useState("");
  const [asset, setAsset] = useState<Asset | null | "missing">(null);
  const [orders, setOrders] = useState<ServiceOrder[] | null>(null);
  const [allocations, setAllocations] = useState<PartAllocation[]>([]);
  // Motivo do erro ao carregar o aparelho (ex.: migração do estoque ainda não rodada).
  const [failed, setFailed] = useState<string | null>(null);
  const [loans, setLoans] = useState<PartLoan[]>([]);
  const [awaiting, setAwaiting] = useState<AwaitingDevice[]>([]);
  const [borrowers, setBorrowers] = useState<Borrower[]>([]);
  const [picking, setPicking] = useState(false);
  const [lending, setLending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloads, setReloads] = useState(0);

  const key = serial.trim();

  useEffect(() => {
    if (!key) {
      setAsset(null);
      setOrders(null);
      setAllocations([]);
      setLoans([]);
      setFailed(null);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      setFailed(null);
      lookupAsset(client, key)
        .then((found) => active && setAsset(found ?? "missing"))
        .catch(() => active && setAsset(null));
      Promise.all([fetchAssetOrders(client, key), fetchSerialAllocations(client, key), fetchSerialLoans(client, key)])
        .then(([foundOrders, foundAllocations, foundLoans]) => {
          if (!active) return;
          setOrders(foundOrders);
          setAllocations(foundAllocations);
          setLoans(foundLoans);
        })
        .catch((error: unknown) => {
          if (!active) return;
          console.error("Estoque: falha ao carregar o aparelho", error);
          const message = error instanceof Error ? error.message : (error as { message?: string } | null)?.message;
          setFailed(message || "erro desconhecido");
        });
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, key, reloads]);

  // Total de peças alocadas (com os técnicos); atualiza sozinho e quando um pedido é decidido.
  useEffect(() => {
    const load = () =>
      fetchOpenAllocations(client)
        .then(setAllocated)
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [client, reloads, requests.length]);

  // Peças trocadas hoje (o balão mostra qualquer período).
  useEffect(() => {
    const day = today();
    fetchSwappedParts(client, { from: day, to: day, userId: "" })
      .then((found) => setSwappedToday(found.length))
      .catch(() => undefined);
  }, [client, reloads, requests.length]);

  // Aparelhos que as desmontagens enviaram para alocação de peça.
  useEffect(() => {
    fetchAwaitingAllocation(client)
      .then(setAwaiting)
      .catch(() => undefined);
  }, [client, reloads]);

  // Quem pode receber uma peça de teste (técnicos e desmontadores).
  useEffect(() => {
    fetchBorrowers(client)
      .then(setBorrowers)
      .catch(() => undefined);
  }, [client]);

  // A OS atual do aparelho (a mais recente), registrada pelo desmontador.
  const current = orders && orders.length ? orders[orders.length - 1] : undefined;

  const found = asset && asset !== "missing" ? asset : null;
  const model = found ? splitAssetId(found.assetShortId).model : "";
  const taken = current ? openParts(allocations.filter((a) => a.osId === current.id)).map((a) => a.part) : [];
  const takenLoans = current ? loans.filter((l) => l.osId === current.id && l.status === "emprestada").map((l) => l.part) : [];
  const osNumbers = new Map((orders ?? []).map((order) => [order.id, order.osNumber]));

  const next = () => {
    setSerial("");
    serialInput.current?.focus();
  };

  /** Aviso quando o aparelho não tem OS; devolve true se impede de seguir. */
  const osProblem = (result: AllocateResult): boolean => {
    if (result === "no_os") toast("Este aparelho ainda não tem OS. O desmontador precisa registrar a OS.");
    return result === "no_os";
  };

  const lend = async (part: string, borrower: string) => {
    setSaving(true);
    try {
      const result = await lendTestPart(client, { serial: key, part, borrower });
      if (osProblem(result)) return;
      toast(result === "duplicate" ? `${part} já está emprestada nessa OS.` : "Peça de teste emprestada");
      setLending(false);
      setReloads((n) => n + 1);
    } catch {
      toast("Não foi possível emprestar a peça. Tente de novo.");
    } finally {
      setSaving(false);
    }
  };

  const allocate = async (parts: string[]) => {
    setSaving(true);
    try {
      for (const part of parts) {
        const result = await allocatePart(client, { serial: key, part });
        if (osProblem(result)) return;
        if (result === "duplicate") toast(`${part} já está alocada nessa OS.`);
      }
      toast(parts.length === 1 ? "Peça alocada" : `${parts.length} peças alocadas`);
      setPicking(false);
      setReloads((n) => n + 1);
    } catch {
      toast("Não foi possível alocar a peça. Tente de novo.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={recordStyles.panel} aria-label="Estoque">
      <div className={recordStyles.header}>
        <h2>Alocar peças</h2>
      </div>
      <div className={styles.overview}>
        <button
          type="button"
          className={[styles.stat, requests.length ? styles.statAlert : ""].join(" ")}
          onClick={() => setBalloon("requests")}
        >
          <strong>{requests.length}</strong>
          <span>{requests.length === 1 ? "pedido pendente" : "pedidos pendentes"}</span>
        </button>
        <button type="button" className={styles.stat} onClick={() => setBalloon("allocated")}>
          <strong>{allocated ? allocated.length : "…"}</strong>
          <span>{allocated?.length === 1 ? "peça alocada" : "peças alocadas"}</span>
        </button>
        <button type="button" className={styles.stat} onClick={() => setBalloon("awaiting")}>
          <strong>{awaiting.length}</strong>
          <span>{awaiting.length === 1 ? "aparelho aguardando alocação" : "aparelhos aguardando alocação"}</span>
        </button>
        <button type="button" className={styles.stat} onClick={() => setBalloon("swapped")}>
          <strong>{swappedToday ?? "…"}</strong>
          <span>{swappedToday === 1 ? "peça trocada hoje" : "peças trocadas hoje"}</span>
        </button>
      </div>
      <div className={serviceStyles.form}>
        <label className={serviceStyles.field}>
          Serial
          <input
            ref={serialInput}
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="Bipe o serial"
            autoComplete="off"
            autoFocus
            disabled={saving}
          />
        </label>
        <label className={serviceStyles.field}>
          Modelo
          <input value={model} readOnly disabled placeholder="—" />
        </label>
        <label className={serviceStyles.field}>
          OS atual
          <input value={current?.osNumber ?? ""} readOnly disabled placeholder="—" />
        </label>
        <Button onClick={() => setPicking(true)} disabled={saving || !key || !current}>
          Alocar peça
        </Button>
        <Button variant="ghost" onClick={() => setLending(true)} disabled={saving || !key || !current}>
          Emprestar peça de teste
        </Button>
      </div>
      {asset === "missing" && key && (
        <p className={serviceStyles.hint}>Serial não encontrado na lista de ativos. A alocação será registrada só com o serial.</p>
      )}
      {key && orders && !current && (
        <p className={serviceStyles.hint}>Este aparelho ainda não tem OS. O desmontador registra a OS (aba Ordens de serviço) antes de alocar peça.</p>
      )}

      {key && (
        <>
          <div className={serviceStyles.summary}>
            <span>
              {failed
                ? `Não foi possível carregar as peças deste aparelho (${failed}). Confira se as migrações do estoque foram rodadas.`
                : orders
                  ? allocations.length === 0
                    ? "Nenhuma peça alocada a este aparelho ainda."
                    : `${allocations.length} ${allocations.length === 1 ? "peça alocada" : "peças alocadas"} a este aparelho.`
                  : "Carregando…"}
            </span>
            <Button variant="small" onClick={next}>
              Próximo ativo
            </Button>
          </div>
          {allocations.length > 0 && (
            <ul className={serviceStyles.list}>
              {allocations.map((allocation) => (
                <li key={allocation.id} className={styles.allocation}>
                  <span className={serviceStyles.number}>{allocation.part}</span>
                  <span className={serviceStyles.meta}>
                    OS {osNumbers.get(allocation.osId) ?? "—"} · {formatDateTime(allocation.createdAt)} · {allocation.allocatedBy}
                  </span>
                  <span className={[styles.status, styles[allocation.status]].join(" ")}>
                    {ALLOCATION_LABELS[allocation.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {loans.length > 0 && (
        <ul className={serviceStyles.list}>
          {loans.map((loan) => (
            <li key={loan.id} className={styles.allocation}>
              <span className={serviceStyles.number}>{loan.part}</span>
              <span className={serviceStyles.meta}>Peça de teste · OS {osNumbers.get(loan.osId) ?? "—"}</span>
              <span className={styles.status}>
                {loan.status === "emprestada" ? "Emprestada" : loan.status === "em_uso" ? "Liberada para uso" : "Devolvida"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <OverviewDialog open={balloon === "requests"} title="Pedidos pendentes" onClose={() => setBalloon(null)}>
        {requests.length === 0 ? (
          <div className={overviewStyles.empty}>Nenhum pedido pendente.</div>
        ) : (
          requests.map((item) => (
            <RequestCard key={item.id} item={item} flat busy={busyId === item.id} onDecide={(it, decision) => void decide(it, decision)} />
          ))
        )}
      </OverviewDialog>
      <OverviewDialog open={balloon === "allocated"} title="Peças alocadas" onClose={() => setBalloon(null)}>
        <AllocatedParts client={client} />
      </OverviewDialog>
      <OverviewDialog open={balloon === "awaiting"} title="Aparelhos aguardando alocação de peça" onClose={() => setBalloon(null)}>
        {awaiting.length === 0 ? (
          <div className={overviewStyles.empty}>Nenhum aparelho aguardando alocação.</div>
        ) : (
          <ul className={overviewStyles.list}>
            {awaiting.map((device) => (
              <li key={device.id}>
                <strong>{device.model ?? "Modelo não encontrado"}</strong>
                <span className={overviewStyles.meta}>
                  enviado pela {device.kind === "desmontagem_tecnica" ? "desmontagem técnica" : "desmontagem"} por {device.sender} em{" "}
                  {formatDateTime(device.since)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </OverviewDialog>
      <OverviewDialog open={balloon === "swapped"} title="Peças trocadas" onClose={() => setBalloon(null)}>
        <SwappedParts client={client} />
      </OverviewDialog>
      <LendTestDialog
        open={lending}
        busy={saving}
        model={model}
        borrowers={borrowers}
        taken={takenLoans}
        onCancel={() => setLending(false)}
        onConfirm={(part, borrower) => void lend(part, borrower)}
      />
      <PartPickerDialog
        open={picking}
        busy={saving}
        model={model}
        taken={taken}
        onCancel={() => setPicking(false)}
        onConfirm={(parts) => void allocate(parts)}
      />
    </section>
  );
}
