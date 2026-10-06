import type { ReactNode } from "react";
import { Button } from "../components/Button/Button";
import { LoginScreen } from "../components/LoginScreen/LoginScreen";
import { useAuth } from "./AuthProvider";

/** Só deixa o app aparecer para quem entrou com o Google (ou no modo local, sem Supabase). */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status, signOut } = useAuth();

  if (status === "loading") return <LoginScreen busy />;
  if (status === "signedOut") return <LoginScreen />;
  if (status === "error") {
    return (
      <LoginScreen message="Não foi possível carregar o seu perfil. Saia e entre novamente.">
        <Button variant="ghost" onClick={() => void signOut()}>
          Sair
        </Button>
      </LoginScreen>
    );
  }
  return <>{children}</>;
}
