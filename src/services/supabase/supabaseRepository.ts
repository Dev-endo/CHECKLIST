import type { DeviceDoc, DeviceRecord, Results } from "../../domain/device";
import { RECORDS_LIMIT, type DeviceRepository } from "../deviceRepository";
import type { AppSupabaseClient } from "./client";
import type { Tables, TablesInsert } from "./database.types";

type DeviceRow = Tables<"devices">;
/** Linha com o perfil do dono, quando a consulta traz `profiles(...)`. */
export type DeviceRowWithOwner = DeviceRow & { profiles?: { name: string; email: string } | null };

const TABLE = "devices";

export function toRecord(row: DeviceRowWithOwner): DeviceRecord {
  return {
    id: row.id,
    modelo: row.model,
    serial: row.serial,
    tec: row.technician,
    r: (row.results ?? {}) as Results,
    fase: row.phase,
    ativo: row.asset_short_id ?? undefined,
    status: row.status,
    falhas: row.failed_items,
    testados: row.tested_count,
    criado: row.created_at,
    atualizado: row.updated_at,
    autor: row.user_id,
    colaborador: row.profiles ? row.profiles.name || row.profiles.email : undefined,
  };
}

/** created_at e updated_at ficam a cargo do banco (default e trigger). */
function toRow(id: string, userId: string, doc: DeviceDoc): TablesInsert<"devices"> {
  return {
    id,
    user_id: userId,
    model: doc.modelo,
    serial: doc.serial,
    asset_short_id: doc.ativo ?? null,
    technician: doc.tec,
    results: doc.r,
    // O banco só aceita criar como pendente; concluir é um segundo passo.
    phase: "pendente",
    status: doc.status,
    tested_count: doc.testados,
    failed_items: doc.falhas,
  };
}

const byUpdatedDesc = (a: DeviceRecord, b: DeviceRecord) => (b.atualizado ?? "").localeCompare(a.atualizado ?? "");

/** Junta duas listas por id, mantendo a versão mais recente de cada registro. */
function merge(current: readonly DeviceRecord[], incoming: readonly DeviceRecord[]): DeviceRecord[] {
  const byId = new Map(current.map((r) => [r.id, r]));
  for (const record of incoming) {
    const existing = byId.get(record.id);
    if (!existing || (record.atualizado ?? "") >= (existing.atualizado ?? "")) byId.set(record.id, record);
  }
  return [...byId.values()].sort(byUpdatedDesc).slice(0, RECORDS_LIMIT);
}

/** Registros do próprio usuário logado; as consultas de supervisor ficam em reviewService. */
export class SupabaseRepository implements DeviceRepository {
  readonly kind = "shared";
  /** Avisa as assinaturas abertas sobre gravações locais, sem esperar o realtime. */
  private readonly savedListeners = new Set<(record: DeviceRecord) => void>();

  constructor(
    private readonly client: AppSupabaseClient,
    private readonly userId: string,
  ) {}

  subscribe(onChange: (records: DeviceRecord[]) => void, onError: (error: unknown) => void) {
    let records: DeviceRecord[] = [];
    let active = true;

    const apply = (next: DeviceRecord[]) => {
      if (!active) return;
      records = next;
      onChange(records);
    };

    const load = async () => {
      const { data, error } = await this.client
        .from(TABLE)
        .select("*")
        .eq("user_id", this.userId)
        .order("updated_at", { ascending: false })
        .limit(RECORDS_LIMIT);
      if (!active) return;
      if (error) onError(error);
      else apply(merge(records, data.map(toRecord)));
    };

    const onSaved = (record: DeviceRecord) => apply(merge(records, [record]));
    this.savedListeners.add(onSaved);

    const channel = this.client
      .channel(`devices-${crypto.randomUUID()}`)
      .on<DeviceRow>(
        "postgres_changes",
        { event: "*", schema: "public", table: TABLE, filter: `user_id=eq.${this.userId}` },
        (payload) => {
          if (payload.eventType === "DELETE") {
            apply(records.filter((r) => r.id !== payload.old.id));
          } else {
            apply(merge(records, [toRecord(payload.new)]));
          }
        },
      )
      .subscribe((status) => {
        // Recarrega a cada (re)conexão para recuperar eventos perdidos.
        if (status === "SUBSCRIBED") void load();
      });

    // Carrega já, mesmo que o realtime demore ou esteja bloqueado na rede.
    void load();

    return () => {
      active = false;
      this.savedListeners.delete(onSaved);
      void this.client.removeChannel(channel);
    };
  }

  async save(id: string, doc: DeviceDoc) {
    const upserted = await this.client.from(TABLE).upsert(toRow(id, this.userId, doc)).select().single();
    if (upserted.error) throw upserted.error;
    let row: DeviceRow = upserted.data;

    if (doc.fase === "concluido") {
      const concluded = await this.client.from(TABLE).update({ phase: "concluido" }).eq("id", id).select().single();
      if (concluded.error) throw concluded.error;
      row = concluded.data;
    }

    const record = toRecord(row);
    this.savedListeners.forEach((listener) => listener(record));
  }
}
