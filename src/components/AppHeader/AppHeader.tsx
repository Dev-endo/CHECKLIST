import { useState } from "react";
import { navGroups, TAB_LABELS } from "../../domain/navigation";
import { ROLE_LABELS, type TabId, type UserRole } from "../../domain/roles";
import { Button } from "../Button/Button";
import styles from "./AppHeader.module.css";

export type AppTab = TabId;

interface AppHeaderProps {
  tabs: readonly AppTab[];
  active: AppTab;
  onChange: (tab: AppTab) => void;
  user: { name: string; email: string; roles: readonly UserRole[] } | null;
  onSignOut: () => void;
}

export function AppHeader({ tabs, active, onChange, user, onSignOut }: AppHeaderProps) {
  // Última aba aberta em cada grupo: voltar ao grupo reabre onde a pessoa estava.
  const [lastTab, setLastTab] = useState<Record<string, AppTab>>({});

  // Sem login (modo local) e com uma só aba, não há o que mostrar.
  if (!user && tabs.length < 2) return null;

  const groups = navGroups(tabs);
  const activeGroup = groups.find((group) => group.tabs.includes(active)) ?? groups[0];

  const open = (groupId: string, tab: AppTab) => {
    setLastTab((prev) => ({ ...prev, [groupId]: tab }));
    onChange(tab);
  };

  return (
    <div className={styles.bar}>
      <div className={styles.nav}>
        <nav className={styles.tabs} aria-label="Seções">
          {groups.map((group) => {
            const remembered = lastTab[group.id];
            const target = remembered && group.tabs.includes(remembered) ? remembered : (group.tabs[0] as AppTab);
            return (
              <button
                key={group.id}
                type="button"
                className={styles.tab}
                aria-current={group === activeGroup ? "page" : undefined}
                onClick={() => open(group.id, target)}
              >
                {group.label}
              </button>
            );
          })}
        </nav>
        {activeGroup && activeGroup.tabs.length > 1 && (
          <nav className={styles.subtabs} aria-label={activeGroup.label}>
            {activeGroup.tabs.map((tab) => (
              <button
                key={tab}
                type="button"
                className={styles.subtab}
                aria-current={tab === active ? "page" : undefined}
                onClick={() => open(activeGroup.id, tab)}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
          </nav>
        )}
      </div>
      {user && (
        <div className={styles.user}>
          <span className={styles.who}>
            <span className={styles.name}>{user.name || user.email}</span>
            <span className={styles.role}>{user.roles.map((role) => ROLE_LABELS[role]).join(" · ")}</span>
          </span>
          <Button variant="small" onClick={onSignOut}>
            Sair
          </Button>
        </div>
      )}
    </div>
  );
}
