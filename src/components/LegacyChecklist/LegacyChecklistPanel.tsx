import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import {
  choiceTests,
  expectedOutcome,
  FINISH_DESTINATIONS,
  finishBlockers,
  skippedPhases,
  PHASE_KIND,
  PHASE_LABELS,
  phaseCatalog,
  phaseFailed,
  PHASES,
  requiredTests,
  type FinishDestination,
} from "../../domain/repairChecklist";
import { describeRepairError, GLASS_LABELS, type GlassAnswer } from "../../domain/repairStages";
import { useRepairChecklists } from "../../hooks/useRepairChecklists";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { canManageUsers } from "../../domain/roles";
import {
  adminReassignChecklist,
  fetchHandover,
  fetchPersonName,
  listMaintenanceTechnicians,
  myChecklistReleasePending,
  requestChecklistRelease,
  type MaintenanceTechnician,
  fetchLastLegacy,
  fetchMyLegacyFinished,
  fetchMyOpenStages,
  declareMaintenanceItems,
  finishMaintenance,
  requestGlassParts,
  analysisSetBoardNote,
  analysisTransfer,
  startAnalysisChecklist,
  startLegacyMaintenance,
  takeAnalysisChecklist,
  takeLegacyChecklist,
  type LegacyChecklist,
  type OpenStage,
} from "../../services/supabase/repairService";
import { assetsBySerial } from "../../services/supabase/stockBoardService";
import { confirmTransfer, fetchMyBalloons, listLabTechnicians, transferBalloon, type LabTechnician, type MyBalloon } from "../../services/supabase/labDayService";
import { serialKey, SOURCE_LABELS } from "../../domain/labDay";
import { fetchAnalysisQueue, type AnalysisItem } from "../../services/supabase/analysisTechService";
import { serialOfOrder } from "../../services/supabase/serviceOrderService";
import appStyles from "../../App.module.css";
import { Button } from "../Button/Button";
import { Checklist } from "../Checklist/Checklist";
import { ChoiceCards } from "../ChoiceCards/ChoiceCards";
import { OsField } from "../DeviceForm/OsField";
import { PtRejection } from "../PtApproval/PtRejection";
import { FinishPanel } from "../RepairStage2/FinishPanel";
import { DoneMaintenanceDialog, type DoneItem } from "./DoneMaintenanceDialog";
import { useToast } from "../Toast/ToastProvider";
import stage1Styles from "../RepairStage1/RepairStage1.module.css";
import stage2Styles from "../RepairStage2/RepairStage2.module.css";
import styles from "./LegacyChecklist.module.css";

const LOOKUP_DEBOUNCE_MS = 400;

const DESTINATION_LABELS = {
  quarentena: "Quarentena",
  analise: "Análise técnica",
  vidro: "Vidro",
  revenda: "Revenda",
  pt: "PT (aprovação pendente)",
  bloqueado: "Bloqueado",
  manutencao: "Transferido para técnico",
} as const;

/**
 * Destinos do Checklist manutenção: os do Reparo (o Vidro não volta sozinho) mais Transferir para técnico. O destino é
 * sempre escolhido: teste reprovado não manda sozinho para a Análise técnica.
 */
const LEGACY_DESTINATIONS = [
  ...FINISH_DESTINATIONS.map((option) =>
    option.id === "vidro"
      ? { ...option, hint: "Não precisa do checklist: abre o serviço na aba Vidro. Depois, o supervisor ou o técnico de vidro direciona para um técnico." }
      : option.id === "auto"
        ? { id: "quarentena" as const, label: "Quarentena", hint: "Vai para a quarentena, mesmo com algum teste reprovado (a falha fica registrada)." }
        : option,
  ),
  {
    id: "manutencao" as const,
    label: "Transferir para técnico",
    hint: "Passa o ativo para outro técnico (o que já foi marcado fica salvo). Conta como finalizado para você; ele confirma o recebimento.",
  },
];

const BALLOONS_POLL_MS = 15_000;

const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const hour = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

/** Por que o checklist não abriu (sem OS o técnico registra ali mesmo). */
type Problem = { kind: "no_os" } | { kind: "confirm_os"; os: string | null } | { kind: "other_owner"; name: string } | { kind: "message"; text: string; waiting?: boolean } | null;

function problemFor(error: unknown): Problem {
  const text = (error as { message?: string })?.message ?? "";
  if (text.includes("no_os")) return { kind: "no_os" };
  if (text.includes("legacy_other_owner")) return { kind: "other_owner", name: (error as { details?: string })?.details || "outro técnico" };
  if (text.includes("lab_in_balloon"))
    return { kind: "message", text: `Este ativo está no balão de ${(error as { details?: string })?.details || "um técnico"} (Dia Laboratório): segue com ele.` };
  if (text.includes("disassembly_open")) return { kind: "message", text: "Este aparelho está no Estágio 1 do Reparo: siga por lá." };
  if (text.includes("in_repair")) return { kind: "message", text: "Este aparelho está no Estágio 2 do Reparo: siga por lá." };
  if (text.includes("pt_pending")) return { kind: "message", text: "Este aparelho tem um PT aguardando a aprovação de um administrador ou supervisor." };
  if (text.includes("in_glass")) return { kind: "message", waiting: true, text: "Este aparelho está no Vidro. O checklist volta para quem o enviou quando o vidro terminar." };
  return { kind: "message", text: describeRepairError(error as { code?: string; message?: string }, "Não foi possível abrir o checklist. Tente de novo.") };
}

/** O checklist aberto para o serial bipado: novo ou retomado. */
interface Opened {
  serial: string;
  stageId: string;
  osNumber: string;
  /** Retomado (estava começado) ou novo; no novo, o último finalizado do aparelho, se houver. */
  resumed: boolean;
  previous: LegacyChecklist | null;
  /** Vidro e outra manutenção já marcado (Vidro e Aro pedidos). */
  needsGlass: boolean;
  /** Quem está com o checklist (técnico dono da manutenção). */
  ownerId: string | null;
}

/**
 * Aba Checklist manutenção: os testes com o aparelho aberto e fechado ficam sempre na tela. O técnico bipa o serial
 * (modelo e Unit ID aparecem na hora); o que ele já tinha marcado é gravado no checklist do aparelho. Checklist
 * começado é retomado; aparelho já finalizado ganha um checklist novo. Ao finalizar: quarentena, análise técnica ou
 * vidro. No topo, quantos checklists o técnico finalizou hoje.
 */
export function LegacyChecklistPanel({ mode = "manutencao" }: { mode?: "manutencao" | "analise" } = {}) {
  const { user, client } = useAuth();
  const analysis = mode === "analise";
  if (!client || !user) return <p className={appStyles.banner}>Entre com a sua conta para usar o {analysis ? "Análise técnica" : "Checklist manutenção"}.</p>;
  return (
    <Legacy
      key={mode}
      client={client}
      userId={user.id}
      technician={user.name || user.email}
      admin={!analysis && canManageUsers(user.roles)}
      analysis={analysis}
    />
  );
}

/**
 * analysis: aba Análise técnica. Mesma estrutura do Checklist manutenção antigo (bipa o serial e o checklist abre), sem
 * balões, meta nem transferência; só o analista usa.
 */
function Legacy({
  client,
  userId,
  technician,
  admin,
  analysis,
}: {
  client: AppSupabaseClient;
  userId: string;
  technician: string;
  admin: boolean;
  analysis: boolean;
}) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [serial, setSerial] = useState("");
  const [asset, setAsset] = useState<{ model: string | null; unit: string } | null | undefined>(undefined);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [opening, setOpening] = useState(false);
  const [tries, setTries] = useState(0);
  const [destination, setDestination] = useState<FinishDestination>("auto");
  // "O aparelho é vidro?" (obrigatório). Só vidro e vidro e outra manutenção vão para o vidro sem checklist.
  const [glassAnswer, setGlassAnswer] = useState<GlassAnswer | null>(null);
  const [analysisNote, setAnalysisNote] = useState("");
  // Motivo da revenda ou do PT.
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // Balão das manutenções feitas, aberto ao finalizar.
  const [asking, setAsking] = useState(false);
  const [lastDone, setLastDone] = useState<{ serial: string; outcome: keyof typeof DESTINATION_LABELS } | null>(null);
  const [mine, setMine] = useState<OpenStage[]>([]);
  const [today, setToday] = useState<LegacyChecklist[] | null>(null);
  const [reloads, setReloads] = useState(0);
  const retry = useCallback(() => setTries((n) => n + 1), []);
  // "Fazer um novo?" aceito: de quem era o checklist (para o aviso).
  const [tookFrom, setTookFrom] = useState<{ serial: string; name: string } | null>(null);
  // OS obrigatória: checklist novo só abre depois de o técnico confirmar a OS atual ou registrar uma nova passagem.
  const [osConfirmed, setOsConfirmed] = useState<string | null>(null);
  const [currentOs, setCurrentOs] = useState<string | null | undefined>(undefined);
  // "Usar uma nova OS" escolhido: mostra o campo para registrar.
  const [newOs, setNewOs] = useState(false);
  // Troca de responsável (admin) e pedido de liberação (técnico, quando o checklist está com outro).
  const [ownerName, setOwnerName] = useState<string | null>(null);
  const [crew, setCrew] = useState<MaintenanceTechnician[]>([]);
  const [requested, setRequested] = useState(false);
  // Por que o checklist está com o outro: ele começou, ou o ativo foi direcionado a ele (e por quem).
  const [ownerInfo, setOwnerInfo] = useState<{ directed: boolean; from: string | null } | null>(null);
  // Dia Laboratório: os balões do técnico (um por ativo) e, na transferência, para quem vai.
  const [balloons, setBalloons] = useState<MyBalloon[] | null>(null);
  const [balloonReloads, setBalloonReloads] = useState(0);
  const [labTechs, setLabTechs] = useState<LabTechnician[]>([]);
  const [transferTo, setTransferTo] = useState("");
  useEffect(() => {
    if (analysis) return;
    let active = true;
    const load = () =>
      fetchMyBalloons(client)
        .then((found) => active && setBalloons(found))
        .catch(() => active && setBalloons((current) => current ?? []));
    void load();
    const poll = setInterval(() => void load(), BALLOONS_POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, balloonReloads, analysis]);
  useEffect(() => {
    let active = true;
    listLabTechnicians(client)
      .then(
        (found) =>
          active &&
          setLabTechs(
            found
              .filter((item) => analysis || item.id !== userId)
              .sort((a, b) => Number(b.id === userId) - Number(a.id === userId) || a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }))
              .map((item) => (item.id === userId ? { ...item, name: `${item.name} (você)` } : item)),
          ),
      )
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, userId, analysis]);
  // O balão do serial bipado ("none": não é balão seu; "loading": a lista ainda não chegou).
  const balloon = serial && balloons ? balloons.find((item) => serialKey(item.serial) === serialKey(serial)) ?? null : null;
  const balloonState = !serial ? "" : analysis ? "analise" : balloons === null ? "loading" : balloon ? `${balloon.id}:${balloon.status}` : "none";
  // Análise técnica: os aparelhos que aguardam a análise (para escolher sem bipar).
  const [waiting, setWaiting] = useState<AnalysisItem[] | null>(null);
  useEffect(() => {
    if (!analysis) return;
    let active = true;
    const load = () =>
      fetchAnalysisQueue(client)
        .then((found) => active && setWaiting(found.filter((item) => item.status === "aguardando")))
        .catch(() => active && setWaiting((current) => current ?? []));
    void load();
    const poll = setInterval(() => void load(), BALLOONS_POLL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [client, analysis, balloonReloads]);
  // Outro serial: esquece a OS do anterior e a escolha de OS nova.
  useEffect(() => {
    setCurrentOs(undefined);
    setNewOs(false);
  }, [serial]);

  // Nome de quem está com o checklist aberto (pode não ser quem bipou, quando o admin abre o de outro).
  const openedOwner = opened?.ownerId ?? null;
  useEffect(() => {
    setOwnerName(null);
    if (!openedOwner || openedOwner === userId) return;
    let active = true;
    fetchPersonName(client, openedOwner)
      .then((name) => active && setOwnerName(name))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, openedOwner, userId]);

  // Admin: lista de técnicos para trocar o responsável.
  useEffect(() => {
    if (!admin) return;
    listMaintenanceTechnicians(client)
      .then(setCrew)
      .catch(() => undefined);
  }, [client, admin]);

  // Checklist de outro técnico: já existe pedido de liberação meu para este serial?
  const blockedBy = problem?.kind === "other_owner" ? serial : "";
  useEffect(() => {
    setRequested(false);
    if (!blockedBy) return;
    let active = true;
    myChecklistReleasePending(client, blockedBy)
      .then((found) => active && setRequested(found))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, blockedBy]);

  useEffect(() => {
    setOwnerInfo(null);
    if (!blockedBy) return;
    let active = true;
    (async () => {
      const last = await fetchLastLegacy(client, blockedBy).catch(() => null);
      const handover = last && last.status !== "concluida" ? await fetchHandover(client, last.id) : null;
      if (active) setOwnerInfo({ directed: Boolean(handover), from: handover?.from ?? null });
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, blockedBy]);

  // Pedido enviado: tenta abrir de novo até o admin liberar (o checklist passa para quem pediu).
  useEffect(() => {
    if (!requested || !blockedBy) return;
    const poll = setInterval(retry, 10_000);
    return () => clearInterval(poll);
  }, [requested, blockedBy, retry]);

  const requestRelease = async () => {
    setBusy(true);
    try {
      await requestChecklistRelease(client, serial);
      setRequested(true);
      toast("Pedido enviado ao admin. Quando ele liberar, o checklist passa para você.");
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível pedir a liberação. Tente de novo."));
    } finally {
      setBusy(false);
    }
  };

  const reassign = async (technicianId: string) => {
    if (!technicianId || !stageId) return;
    const name = crew.find((item) => item.id === technicianId)?.name ?? "o técnico";
    if (!window.confirm(`Passar o checklist de ${serial} para ${name}? As marcações feitas ficam.`)) return;
    setBusy(true);
    try {
      await adminReassignChecklist(client, stageId, technicianId);
      toast(`Checklist passado para ${name}`);
      setOpened((current) => (current && current.stageId === stageId ? { ...current, ownerId: technicianId } : current));
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível trocar o responsável."));
    } finally {
      setBusy(false);
    }
  };

  // Digitou o serial ou o número da OS: se for uma OS registrada, troca pelo serial do aparelho dela.
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      const value = typed.trim();
      if (!value) {
        setSerial("");
        return;
      }
      serialOfOrder(client, value)
        .catch(() => null)
        .then((found) => {
          if (!active) return;
          if (found && found.trim().toLowerCase() !== value.toLowerCase()) {
            toast(`OS ${value}: aparelho ${found}`);
            setTyped(found);
            setSerial(found.trim());
          } else setSerial(value);
        });
    }, LOOKUP_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [typed, client, toast]);

  // Bipou: modelo e Unit ID na hora.
  useEffect(() => {
    setAsset(undefined);
    if (!serial) return;
    let active = true;
    assetsBySerial(client, [serial])
      .then((found) => active && setAsset(found.get(serial.toLowerCase()) ?? null))
      .catch(() => active && setAsset(null));
    return () => {
      active = false;
    };
  }, [client, serial]);

  // Bipou: retoma o checklist começado ou abre um novo (o finalizado fica salvo no histórico).
  useEffect(() => {
    setOpened(null);
    setProblem(null);
    if (!serial || balloonState === "loading") return;
    // Só pelos balões (o admin abre qualquer um): o banco confere de novo.
    if (!admin && balloonState === "none") {
      setProblem({ kind: "message", text: "Este ativo não está nos seus balões. Peça ao supervisor para vinculá-lo a você." });
      return;
    }
    if (balloonState.endsWith(":pendente")) {
      setProblem({ kind: "message", text: "Transferência pendente: confirme o recebimento no balão acima para trabalhar neste ativo." });
      return;
    }
    let active = true;
    setOpening(true);
    (async () => {
      const previous = await fetchLastLegacy(client, serial).catch(() => null);
      // Checklist em andamento é retomado direto; um novo espera a OS (confirmar a atual ou registrar outra).
      const inProgress = previous && previous.status !== "concluida";
      if (!inProgress && osConfirmed !== serial) {
        if (active) setProblem({ kind: "confirm_os", os: previous?.osNumber ?? null });
        return;
      }
      const stageId = await (analysis ? startAnalysisChecklist : startLegacyMaintenance)(client, serial);
      const current = await fetchLastLegacy(client, serial).catch(() => null);
      if (!active) return;
      const resumed = previous?.id === stageId && previous.status !== "concluida";
      setOpened({
        serial,
        stageId,
        osNumber: current?.id === stageId ? current.osNumber : "—",
        resumed,
        previous: previous?.status === "concluida" ? previous : null,
        needsGlass: current?.id === stageId ? current.needsGlass : false,
        ownerId: current?.id === stageId ? current.technicianId : null,
      });
    })()
      .catch((error) => active && setProblem(problemFor(error)))
      .finally(() => active && setOpening(false));
    return () => {
      active = false;
    };
  }, [client, serial, tries, osConfirmed, balloonState, admin, analysis]);

  // No Vidro: quando o vidro termina o checklist volta sozinho; a tela tenta abrir de novo até liberar.
  const waitingGlass = Boolean(serial && problem?.kind === "message" && problem.waiting);
  useEffect(() => {
    if (!waitingGlass) return;
    const poll = setInterval(retry, 10_000);
    return () => clearInterval(poll);
  }, [waitingGlass, retry]);

  // Começados e não finalizados (para retomar) e os finalizados hoje (a contagem do dia).
  useEffect(() => {
    let active = true;
    fetchMyOpenStages(client, userId, ["manutencao"], ["em_andamento"], true)
      .then((found) => active && setMine(found))
      .catch(() => undefined);
    fetchMyLegacyFinished(client, userId, startOfToday())
      .then((found) => active && setToday(found))
      .catch(() => active && setToday((current) => current ?? []));
    return () => {
      active = false;
    };
  }, [client, userId, reloads, opened?.stageId]);

  const stageId = opened && opened.serial === serial ? opened.stageId : undefined;
  // Sem trava: o técnico sempre consegue marcar o checklist (sem etapa aberta, fica como rascunho na tela).
  const editable = true;

  // Checklist começado por outro técnico: Sim, fica com quem bipou e começa do zero; Não, continua com o dono.
  const takeOver = async (name: string) => {
    setBusy(true);
    try {
      await (analysis ? takeAnalysisChecklist : takeLegacyChecklist)(client, serial);
      setTookFrom({ serial, name });
      retry();
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível abrir o checklist. Tente de novo."));
    } finally {
      setBusy(false);
    }
  };
  const keepWithOwner = (name: string) => {
    toast(`O checklist continua com ${name}`);
    clear();
  };
  const checklists = useRepairChecklists(client, stageId, editable && !busy, (error) => toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível salvar as marcações.")), true);

  // Outro aparelho aberto: a resposta "é vidro?" do anterior não vale para ele.
  const lastStage = useRef(stageId);
  useEffect(() => {
    if (lastStage.current && stageId && lastStage.current !== stageId) setGlassAnswer(null);
    if (stageId) lastStage.current = stageId;
  }, [stageId]);

  const glassLocked = Boolean(stageId && opened?.needsGlass);
  const glass: GlassAnswer | null = glassLocked ? "vidro_mais" : glassAnswer;
  const toGlass = glass === "so_vidro" || glass === "vidro_mais";
  // Transferir vale com qualquer resposta do vidro (e só para o balão aberto de um técnico).
  // Na análise transfere o checklist aberto; no Checklist manutenção, o balão aberto.
  const canTransfer = analysis ? Boolean(stageId) : Boolean(balloon && balloon.status === "aberto");
  const destinations = (
    toGlass
      ? // Só vidro: Vidro (ou transferir). Vidro e outra manutenção: também a Análise técnica.
        LEGACY_DESTINATIONS.filter(
          (option) => option.id === "vidro" || option.id === "manutencao" || (glass === "vidro_mais" && option.id === "analise"),
        )
      : LEGACY_DESTINATIONS.filter((option) => option.id !== "vidro")
  )
    .filter((option) => option.id !== "manutencao" || canTransfer)
    // Na própria Análise técnica não faz sentido mandar para a análise.
    .filter((option) => !analysis || option.id !== "analise")
    .map((option) =>
      option.id === "vidro" && glass === "vidro_mais"
        ? { ...option, hint: "Faça o checklist com o aparelho aberto: o aparelho vai para a aba Vidro e o fechado é feito depois do vidro." }
        : analysis && option.id === "manutencao"
        ? {
            ...option,
            hint: "Passa o ativo para um técnico (pode ser você), com o que já foi marcado. Ele confirma o recebimento e o ativo entra nos balões dele.",
          }
        : option,
    );
  const finalDestination: FinishDestination =
    destination === "manutencao" && canTransfer
      ? "manutencao"
      : destination === "analise" && glass === "vidro_mais" && !analysis
        ? "analise"
        : toGlass
        ? "vidro"
        : destination === "vidro" || destination === "manutencao"
          ? "auto"
          : destination;

  const answerGlass = async (value: GlassAnswer) => {
    if (glassLocked) return;
    if (value !== "vidro_mais" || !stageId) {
      setGlassAnswer(value);
      return;
    }
    if (!window.confirm("Vidro e outra manutenção: faça a manutenção e o checklist com o aparelho aberto; ao finalizar, o aparelho vai para o vidro. Confirmar?")) return;
    setBusy(true);
    try {
      await requestGlassParts(client, stageId);
      setOpened((current) => (current && current.stageId === stageId ? { ...current, needsGlass: true } : current));
      setGlassAnswer(value);
      toast("Marcado: vidro e outra manutenção");
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível marcar o vidro."));
    } finally {
      setBusy(false);
    }
  };

  // Falha com o aparelho aberto: o checklist fechado não precisa ser feito (o aparelho já não vai para a quarentena).
  const openFailed = phaseFailed("aberto", checklists.results.aberto);
  // Falha com o aparelho aberto dispensa o checklist fechado, a não ser que o destino seja a Quarentena.
  const skipClosed = openFailed && finalDestination !== "quarentena";
  const blockers = [
    ...(stageId ? [] : ["Bipe o serial do aparelho"]),
    // PT e Bloqueado não dependem da resposta do vidro.
    ...(glass || finalDestination === "pt" || finalDestination === "bloqueado" || finalDestination === "manutencao" ? [] : ["Responda se o aparelho é vidro"]),
    ...finishBlockers({
      results: checklists.results,
      requests: [],
      returnsWaiting: 0,
      destination: finalDestination,
      resaleReason: reason,
      skipPhases: skipClosed ? ["fechado"] : [],
      analysisNote,
      technicianId: transferTo,
      glassWithMaintenance: glass === "vidro_mais",
    }),
    // O destino é escolhido (nada vai sozinho para a Análise técnica).
    ...(finalDestination === "auto" ? ["Escolha o destino do aparelho"] : []),
  ];
  const outcome = expectedOutcome(checklists.results, finalDestination === "auto" ? "quarentena" : finalDestination);

  const clear = () => {
    setOsConfirmed(null);
    setTyped("");
    setSerial("");
    setDestination("auto");
    setGlassAnswer(null);
    setAnalysisNote("");
    setReason("");
    setTransferTo("");
    input.current?.focus();
  };

  // Finalizar abre o balão das manutenções feitas; ele confirma e chama o finish.
  // Finalizar (e transferir) abre o balão das manutenções feitas; ele confirma e segue.
  const askFinish = () => {
    if (!stageId || busy) return;
    setAsking(true);
  };

  // Transferir para técnico: o balão passa para ele (pendente até confirmar); conta como finalizado para você.
  const transfer = async (done: DoneItem[]) => {
    if ((!analysis && !balloon) || (analysis && !stageId) || !stageId || !transferTo || busy) return;
    const name = labTechs.find((item) => item.id === transferTo)?.name ?? "o técnico";
    setBusy(true);
    try {
      await checklists.flush();
      // As manutenções de quem transfere ficam no histórico da transferência.
      await declareMaintenanceItems(client, stageId, done);
      if (analysis && stageId) await analysisTransfer(client, stageId, transferTo, reason);
      else if (balloon) await transferBalloon(client, balloon.id, transferTo, reason);
      setAsking(false);
      setLastDone({ serial, outcome: "manutencao" });
      toast(`Ativo transferido para ${name}`);
      setBalloonReloads((n) => n + 1);
      setReloads((n) => n + 1);
      clear();
      window.scrollTo(0, 0);
    } catch (error) {
      setAsking(false);
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível transferir o ativo."));
    } finally {
      setBusy(false);
    }
  };

  // Transferência recebida: confirma e o balão pode ser trabalhado (entra na meta).
  const confirmReceipt = async (item: MyBalloon) => {
    if (!window.confirm(`Confirmar o recebimento de ${item.serial}${item.fromName ? `, transferido por ${item.fromName}` : ""}?`)) return;
    setBusy(true);
    try {
      await confirmTransfer(client, item.id);
      toast("Recebimento confirmado: o ativo entrou na sua meta");
      setBalloonReloads((n) => n + 1);
      setTyped(item.serial);
    } catch (error) {
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível confirmar o recebimento."));
      setBalloonReloads((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (done: DoneItem[], boardNote: string | null) => {
    if (finalDestination === "manutencao") {
      await transfer(done);
      return;
    }
    if (!stageId || busy) return;
    setBusy(true);
    try {
      await checklists.flush();
      await declareMaintenanceItems(client, stageId, done);
      // Análise: reparo em placa marcado nas manutenções feitas, com a observação (registrado ao finalizar).
      if (analysis) await analysisSetBoardNote(client, stageId, boardNote);
      const result = await finishMaintenance(client, {
        stageId,
        requiredOpen: requiredTests("aberto"),
        requiredClosed: skipClosed || skippedPhases(finalDestination).includes("fechado") ? [] : requiredTests("fechado"),
        choice: [...choiceTests("aberto"), ...choiceTests("fechado")],
        destination: finalDestination,
        resaleReason: reason,
        analysisNote,
      });
      if (analysis && boardNote) toast("Reparo em placa registrado");
      setAsking(false);
      setLastDone({ serial, outcome: result });
      setReloads((n) => n + 1);
      setBalloonReloads((n) => n + 1);
      clear();
      window.scrollTo(0, 0);
    } catch (error) {
      setAsking(false);
      toast(describeRepairError(error as { code?: string; message?: string }, "Não foi possível finalizar o checklist."));
    } finally {
      setBusy(false);
    }
  };

  const counts = { quarentena: 0, analise: 0, vidro: 0, revenda: 0, pt: 0, bloqueado: 0 };
  for (const item of today ?? []) if (item.outcome) counts[item.outcome] += 1;
  const breakdown = (Object.keys(counts) as (keyof typeof counts)[])
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${DESTINATION_LABELS[key].toLowerCase()}`)
    .join(" · ");

  return (
    <>
      <header>
        <h1 className={appStyles.title}>{analysis ? "Análise técnica" : "Checklist manutenção"}</h1>
        <p className={appStyles.subtitle}>
          {analysis
            ? "Bipe o serial (ou escolha um aparelho aguardando análise), faça os testes com o aparelho aberto e fechado e finalize: quarentena, vidro, revenda, PT ou bloqueado."
            : "Escolha um dos seus ativos (ou bipe o serial para abrir o balão), faça os testes com o aparelho aberto e fechado e finalize: quarentena, análise técnica, vidro, revenda, PT, bloqueado ou transferir para outro técnico."}
        </p>
      </header>

      <section className={styles.today} aria-label="Seus checklists de hoje">
        <div className={styles.todayMain}>
          <span className={styles.todayLabel}>Você fez hoje</span>
          <strong className={styles.todayValue}>{today?.length ?? "…"}</strong>
          <span>{today?.length === 1 ? "checklist" : "checklists"}</span>
          {breakdown && <span className={styles.todayDetail}>{breakdown}</span>}
        </div>
        {today && today.length > 0 && (
          <details className={styles.todayList}>
            <summary>Ver os de hoje</summary>
            <ul>
              {today.map((item) => (
                <li key={item.id}>
                  <span className={styles.mono}>{item.serial}</span>
                  <span>{item.outcome ? DESTINATION_LABELS[item.outcome] : "—"}</span>
                  <span className={styles.muted}>{item.finishedAt ? hour(item.finishedAt) : ""}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {lastDone && !serial && (
        <p className={stage1Styles.done} role="status">
          Checklist de <strong>{lastDone.serial}</strong> finalizado. Destino: <strong>{DESTINATION_LABELS[lastDone.outcome]}</strong>. Bipe o
          próximo aparelho.
        </p>
      )}

      <div className={styles.top}>
        <div className={stage1Styles.serial}>
          <label htmlFor="legacy-serial">Serial do aparelho ou número da OS</label>
          <div className={styles.serialRow}>
            <input
              id="legacy-serial"
              ref={input}
              value={typed}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={analysis ? "Bipe o serial ou digite a OS" : "Bipe o serial para abrir o balão"}
              disabled={busy}
              onChange={(e) => setTyped(e.target.value)}
            />
            {typed && (
              <Button variant="ghost" onClick={clear} disabled={busy}>
                Limpar
              </Button>
            )}
          </div>
        </div>

        <dl className={stage1Styles.info}>
          <div>
            <dt>Modelo</dt>
            <dd>{!serial ? "—" : asset === undefined ? "Buscando…" : asset?.model ?? "Serial fora da lista de ativos"}</dd>
          </div>
          <div>
            <dt>Unit ID</dt>
            <dd>{!serial || !asset ? "—" : asset.unit}</dd>
          </div>
          <div>
            <dt>OS</dt>
            <dd>{stageId && opened ? opened.osNumber : (serial && currentOs) || "—"}</dd>
          </div>
          <div>
            <dt>Técnico</dt>
            <dd>{stageId && openedOwner && openedOwner !== userId ? (ownerName ?? "…") : technician}</dd>
          </div>
        </dl>
      </div>

      {admin && stageId && crew.length > 0 && (
        <label className={stage1Styles.hint}>
          Responsável pelo checklist (admin):{" "}
          <select value="" disabled={busy} onChange={(e) => void reassign(e.target.value)}>
            <option value="">Trocar para…</option>
            {crew
              .filter((item) => item.id !== openedOwner)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
      )}

      {serial && opening && <p className={stage1Styles.hint}>Abrindo o checklist…</p>}
      {stageId && <PtRejection client={client} stageId={stageId} />}
      {stageId && opened && (
        <p className={stage1Styles.hint} role="status">
          {tookFrom?.serial === serial
            ? `Checklist novo: o que ${tookFrom.name} tinha começado passou para você, em branco (as marcações dele ficam no histórico).`
            : opened.resumed
            ? "Checklist retomado: as marcações já feitas neste aparelho estão abaixo."
            : opened.previous?.finishedAt
              ? `Checklist novo. O anterior deste aparelho foi finalizado em ${when(opened.previous.finishedAt)} (${
                  opened.previous.outcome ? DESTINATION_LABELS[opened.previous.outcome] : "—"
                }) e fica salvo no histórico.`
              : "Checklist novo."}
        </p>
      )}
      {serial && problem?.kind === "message" && <p className={stage1Styles.hint}>{problem.text}</p>}
      {serial && !stageId && !opening && problem?.kind === "confirm_os" && (() => {
        const knownOs = currentOs || problem.os;
        return (
        <section className={styles.osBox} aria-label="OS do aparelho">
          <p>
            {!knownOs && currentOs === null
              ? "Este aparelho não tem OS. Digite a OS e registre: o checklist abre em seguida."
              : `Este aparelho ${knownOs ? `tem a OS ${knownOs}` : "já passou pelo laboratório"}. Se ele foi reprovado na quarentena, use a mesma OS; se voltou ao laboratório numa nova passagem, use uma nova.`}
          </p>
          {(knownOs || currentOs !== null) && (
            <div className={stage1Styles.actions}>
              <Button disabled={busy} onClick={() => setOsConfirmed(serial)}>
                Usar a mesma OS{knownOs ? ` (${knownOs})` : ""}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setNewOs(true)}>
                Usar uma nova OS
              </Button>
            </div>
          )}
          {((!knownOs && currentOs === null) || newOs) && (
            <OsField
              client={client}
              serial={serial}
              required
              disabled={busy}
              onCurrent={setCurrentOs}
              onRegistered={() => {
                setNewOs(false);
                setOsConfirmed(serial);
                retry();
              }}
            />
          )}
          {/* Carrega a OS atual mesmo com o campo escondido. */}
          {currentOs === undefined && !newOs && <OsField client={client} serial={serial} onCurrent={setCurrentOs} disabled />}
        </section>
        );
      })()}
      {serial && !stageId && !opening && (problem?.kind === "no_os" || problem?.kind === "message") && (
        <section className={styles.osBox} aria-label="OS do aparelho">
          <p>
            {problem.kind === "message"
              ? "Se o aparelho voltou ao laboratório numa nova passagem, registre a nova OS: o checklist abre nela."
              : "Este aparelho não tem OS. Digite a OS e registre: o checklist abre em seguida."}
          </p>
          <OsField
            client={client}
            serial={serial}
            required
            disabled={busy}
            onCurrent={setCurrentOs}
            onRegistered={() => {
              setOsConfirmed(serial);
              retry();
            }}
          />
        </section>
      )}
      {serial && problem?.kind === "other_owner" && (
        <section className={styles.owner} role="alertdialog" aria-label="Checklist de outro técnico">
          <p>
            {ownerInfo?.directed ? (
              <>
                O ativo foi direcionado a <strong>{problem.name}</strong>
                {ownerInfo.from ? ` por ${ownerInfo.from}` : ""}.
              </>
            ) : (
              <>
                <strong>{problem.name}</strong> começou o checklist deste ativo.
              </>
            )}{" "}
            {analysis ? "Você pode recomeçar do zero ou deixar com quem começou." : "Solicite a liberação do checklist para fazer você."}
          </p>
          {!analysis && (
            <>
              <div className={stage1Styles.actions}>
                <Button className={styles.green} disabled={busy || requested} onClick={() => void requestRelease()}>
                  {requested ? "Pedido enviado: aguardando o admin liberar" : "Solicitar liberação do checklist"}
                </Button>
              </div>
              <p className={stage1Styles.hint}>
                O admin libera na aba Liberação e o checklist passa para você, com as marcações já feitas. Se preferir recomeçar do zero:
              </p>
            </>
          )}
          <div className={stage1Styles.actions}>
            <Button variant="ghost" disabled={busy} onClick={() => void takeOver(problem.name)}>
              Fazer um novo, do zero
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => keepWithOwner(problem.name)}>
              Deixar com {problem.name}
            </Button>
          </div>
        </section>
      )}

      {!serial && analysis && (
        <section aria-label="Aguardando análise técnica">
          {mine.length > 0 && (
            <div className={stage1Styles.resume}>
              Começados e não finalizados:
              {mine.map((item) => (
                <Button key={item.id} variant="small" onClick={() => setTyped(item.serial)}>
                  {item.serial} · OS {item.osNumber}
                </Button>
              ))}
            </div>
          )}
          <details>
            <summary>Aguardando análise técnica: {waiting?.length ?? "…"}</summary>
            <ul className={stage2Styles.devices}>
              {waiting?.map((item) => (
                <li key={item.id}>
                  <button type="button" className={stage2Styles.device} disabled={busy} onClick={() => setTyped(item.serial)}>
                    <strong className={stage2Styles.deviceSerial}>{item.serial}</strong>
                    <span>{item.model ?? "Modelo não encontrado"}</span>
                    {item.unit && <span className={stage2Styles.muted}>{item.unit}</span>}
                    <span className={stage2Styles.deviceOs}>OS {item.osNumber}</span>
                    {item.sendNote && <span className={stage2Styles.muted}>Motivo: {item.sendNote}</span>}
                    <span className={stage2Styles.muted}>
                      Enviado por {item.sentBy} · {when(item.sentAt ?? item.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      {!serial && !analysis && (
        <section aria-label="Seus balões">
          <h2 className={stage1Styles.heading}>Seus ativos ({balloons?.filter((item) => item.status === "aberto").length ?? "…"})</h2>
          {balloons === null && <p className={stage2Styles.muted}>Carregando…</p>}
          {balloons?.length === 0 && (
            <p className={stage2Styles.muted}>Nenhum ativo com você. O supervisor entrega os ativos na aba Dia Laboratório.</p>
          )}
          <ul className={stage2Styles.devices}>
            {balloons?.map((item) => {
              const pending = item.status === "pendente";
              const started = mine.some((stage) => serialKey(stage.serial) === serialKey(item.serial));
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={[stage2Styles.device, pending ? stage2Styles.deviceWaiting : ""].join(" ")}
                    disabled={busy}
                    onClick={() => (pending ? void confirmReceipt(item) : setTyped(item.serial))}
                  >
                    <strong className={stage2Styles.deviceSerial}>{item.serial}</strong>
                    <span>{item.model ?? "Modelo não encontrado"}</span>
                    {item.unit && <span className={stage2Styles.muted}>{item.unit}</span>}
                    {pending ? (
                      <>
                        <span className={stage2Styles.waitingTag}>{item.fromName ?? "Um técnico"} transferiu esse ativo para você</span>
                        {item.note && <span className={stage2Styles.muted}>Motivo: {item.note}</span>}
                        <span className={stage2Styles.muted}>Clique para confirmar o recebimento</span>
                      </>
                    ) : (
                      <>
                        <span className={stage2Styles.muted}>
                          {started ? "Checklist começado" : SOURCE_LABELS[item.source]}
                          {item.fromName && item.source !== "retorno" ? ` · ${item.fromName}` : ""}
                        </span>
                        {item.note && <span className={stage2Styles.muted}>{item.note}</span>}
                      </>
                    )}
                    <span className={stage2Styles.muted}>desde {when(item.createdAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className={styles.glass} aria-label="O aparelho é vidro?">
        <ChoiceCards
          name="legacy-glass"
          legend="O aparelho é vidro?"
          value={glass}
          onChange={(value) => void answerGlass(value)}
          disabled={busy || glassLocked}
          options={[
            { id: "nao", label: GLASS_LABELS.nao, hint: "Segue o fluxo normal: testes e destino." },
            { id: "so_vidro", label: GLASS_LABELS.so_vidro, hint: "Vai para o vidro sem checklist: finalize logo abaixo." },
            {
              id: "vidro_mais",
              label: GLASS_LABELS.vidro_mais,
              hint: stageId
                ? "Faça a manutenção e o checklist aberto; ao finalizar, vai para o vidro."
                : "Bipe o serial primeiro.",
              disabled: !stageId,
            },
          ]}
        />
        {glassLocked && (
          <p className={stage1Styles.hint} role="status">
            Vidro e outra manutenção marcado. Faça a manutenção e o checklist com o aparelho aberto; ao finalizar, o aparelho vai para o vidro (o
            fechado é feito depois do vidro).
          </p>
        )}
      </section>

      {PHASES.map((phase) => (
        <section key={phase} className={stage2Styles.phase} aria-label={PHASE_LABELS[phase]}>
          <h2 className={stage1Styles.heading}>{PHASE_LABELS[phase]}</h2>
          {phase === "fechado" && skipClosed ? (
            <p className={stage1Styles.hint}>
              Não precisa fazer: o aparelho teve falha nos testes com ele aberto. Se o destino for a Quarentena, o checklist fechado
              volta a ser obrigatório.
            </p>
          ) : !checklists.loaded ? (
            <p className={stage2Styles.muted}>Carregando…</p>
          ) : (
            <Checklist
              kind={PHASE_KIND[phase]}
              blocks={phaseCatalog(phase)}
              results={checklists.phases[phase].results}
              onToggle={(sectionId, result) => checklists.toggleResult(phase, sectionId, result)}
              onToggleItem={(sectionId, itemId) => checklists.toggleItem(phase, sectionId, itemId)}
              battery={checklists.phases[phase].battery}
              onBatteryChange={(value) => checklists.setBattery(phase, value)}
              onConfirm={(itemId, checked) => checklists.setConfirm(phase, itemId, checked)}
              disabled={!editable || busy}
            />
          )}
        </section>
      ))}

      <FinishPanel
        title="Finalizar checklist"
        blockers={blockers}
        outcome={outcome}
        destination={finalDestination}
        resaleReason={reason}
        busy={busy}
        unsaved={Boolean(stageId) && checklists.unsaved}
        onDestination={setDestination}
        onReason={setReason}
        onFinish={askFinish}
        destinations={destinations}
        analysisNote={analysisNote}
        onAnalysisNote={setAnalysisNote}
        hideCount
        glassOpenChecklist={glass === "vidro_mais"}
        technicians={labTechs}
        technicianId={transferTo}
        onTechnician={setTransferTo}
      />

      <DoneMaintenanceDialog
        open={asking}
        busy={busy}
        serial={serial}
        destination={DESTINATION_LABELS[outcome]}
        onCancel={() => setAsking(false)}
        onConfirm={(done, boardNote) => void finish(done, boardNote)}
        boardNote={analysis}
      />
    </>
  );
}
