import { ROLE_LABELS, type UserRole } from "../../domain/roles";
import { Button } from "../Button/Button";
import styles from "./AppHeader.module.css";

export type AppTab = "checklist" | "registros" | "admin";

const TAB_LABELS: Record<AppTab, string> = {
  checklist: "Checklist",
  registros: "Registros",
  admin: "Administração",
};

interface AppHeaderProps {
  tabs: readonly AppTab[];
  active: AppTab;
  onChange: (tab: AppTab) => void;
  user: { name: string; email: string; role: UserRole } | null;
  onSignOut: () => void;
}

export function AppHeader({ tabs, active, onChange, user, onSignOut }: AppHeaderProps) {
  // Sem login (modo local) e com uma só aba, não há o que mostrar.
  if (!user && tabs.length < 2) return null;

  return (
    <div className={styles.bar}>
      <nav className={styles.tabs} aria-label="Seções">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            className={styles.tab}
            aria-current={tab === active ? "page" : undefined}
            onClick={() => onChange(tab)}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </nav>
      {user && (
        <div className={styles.user}>
          <span className={styles.who}>
            <span className={styles.name}>{user.name || user.email}</span>
            <span className={styles.role}>{ROLE_LABELS[user.role]}</span>
          </span>
          <Button variant="small" onClick={onSignOut}>
            Sair
          </Button>
        </div>
      )}
    </div>
  );
}
