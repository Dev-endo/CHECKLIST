import { useEffect, useState, type ReactNode } from "react";
import { ROLE_LABELS, ROLES, type UserRole } from "../../domain/roles";
import type { AppSupabaseClient } from "../../services/supabase/client";
import { fetchProfiles, updateRole, type Profile } from "../../services/supabase/profilesService";
import { formatDateTime } from "../../utils/format";
import { AssetImport } from "./AssetImport";
import { useToast } from "../Toast/ToastProvider";
import recordStyles from "../RecordsPanel/RecordsPanel.module.css";
import styles from "./AdminPanel.module.css";

interface AdminPanelProps {
  client: AppSupabaseClient;
  /** Usuário logado: o admin não altera o próprio papel. */
  currentUserId: string;
}

/** Lista de usuários e atribuição de papéis; só o admin chega aqui. */
export function AdminPanel({ client, currentUserId }: AdminPanelProps) {
  const toast = useToast();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchProfiles(client)
      .then((found) => active && setProfiles(found))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [client]);

  const handleChange = async (profile: Profile, role: UserRole) => {
    if (role === profile.role) return;
    setSavingId(profile.id);
    try {
      await updateRole(client, profile.id, role);
      setProfiles((prev) => prev?.map((p) => (p.id === profile.id ? { ...p, role } : p)) ?? prev);
      toast(`${profile.name || profile.email}: ${ROLE_LABELS[role]}`);
    } catch {
      toast("Não foi possível alterar o papel");
    } finally {
      setSavingId(null);
    }
  };

  let body: ReactNode;
  if (failed) body = <div className={recordStyles.empty}>Não foi possível carregar os usuários.</div>;
  else if (!profiles) body = <div className={recordStyles.empty}>Carregando usuários…</div>;
  else
    body = profiles.map((profile) => {
      const isSelf = profile.id === currentUserId;
      return (
        <div key={profile.id} className={styles.row}>
          <div>
            <div className={recordStyles.title}>{profile.name || "Sem nome"}</div>
            <div className={recordStyles.meta}>
              {profile.email} · desde {formatDateTime(profile.createdAt)}
            </div>
          </div>
          <select
            className={styles.select}
            value={profile.role}
            disabled={isSelf || savingId === profile.id}
            title={isSelf ? "Você não pode alterar o seu próprio papel" : undefined}
            aria-label={`Papel de ${profile.name || profile.email}`}
            onChange={(e) => void handleChange(profile, e.target.value as UserRole)}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>
      );
    });

  return (
    <>
      <AssetImport client={client} />
      <section className={recordStyles.panel} aria-label="Administração de usuários">
        <div className={recordStyles.header}>
          <h2>Usuários e acessos</h2>
        </div>
        <p className={styles.note}>
          Quem entra com o Google começa como Colaborador. Supervisor e Administrador veem os checklists de todos; só o
          Administrador altera papéis.
        </p>
        {body}
      </section>
    </>
  );
}
