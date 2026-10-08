import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import type { UserRole } from "../domain/roles";
import { ALLOWED_EMAIL_DOMAIN } from "./allowedDomain";
import { getSupabaseClient, type AppSupabaseClient } from "../services/supabase/client";
import { fetchProfile, type Profile } from "../services/supabase/profilesService";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export type AuthStatus = "loading" | "signedOut" | "ready" | "error";

interface AuthContextValue {
  status: AuthStatus;
  /** Sem Supabase configurado não há login: o app roda no modo local. */
  authEnabled: boolean;
  user: AuthUser | null;
  client: AppSupabaseClient | null;
  signIn: () => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toUser(profile: Profile): AuthUser {
  return { id: profile.id, name: profile.name, email: profile.email, role: profile.role };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = getSupabaseClient();
  // undefined: ainda lendo a sessão salva no navegador.
  const [session, setSession] = useState<Session | null | undefined>(client ? undefined : null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const userId = session?.user.id;

  useEffect(() => {
    if (!client) return;
    // Também recebe a sessão inicial e a troca do código do Google ao voltar do login.
    const { data } = client.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, [client]);

  useEffect(() => {
    setProfile(null);
    setProfileFailed(false);
    if (!client || !userId) return;
    let active = true;
    fetchProfile(client, userId)
      .then((found) => {
        if (!active) return;
        if (found) setProfile(found);
        else setProfileFailed(true);
      })
      .catch(() => active && setProfileFailed(true));
    return () => {
      active = false;
    };
  }, [client, userId]);

  const signIn = useCallback(async () => {
    if (!client) return null;
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin + import.meta.env.BASE_URL,
        queryParams: { prompt: "select_account", hd: ALLOWED_EMAIL_DOMAIN },
      },
    });
    return error ? error.message : null;
  }, [client]);

  const signOut = useCallback(async () => {
    await client?.auth.signOut();
  }, [client]);

  const value = useMemo<AuthContextValue>(() => {
    let status: AuthStatus;
    if (!client) status = "ready";
    else if (session === undefined) status = "loading";
    else if (session === null) status = "signedOut";
    else if (profileFailed) status = "error";
    else status = profile ? "ready" : "loading";
    return {
      status,
      authEnabled: client !== null,
      user: profile ? toUser(profile) : null,
      client,
      signIn,
      signOut,
    };
  }, [client, session, profile, profileFailed, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth precisa estar dentro de <AuthProvider>");
  return value;
}
