import { useState, type ReactNode } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../Button/Button";
import styles from "./LoginScreen.module.css";

interface LoginScreenProps {
  /** Verificando a sessão salva; sem botão. */
  busy?: boolean;
  message?: string;
  children?: ReactNode;
}

/** O Supabase devolve o motivo na URL quando o login é recusado (por exemplo, e-mail de outro domínio). */
function readRedirectError(): string | null {
  const params = new URLSearchParams(window.location.search + "&" + window.location.hash.replace(/^#/, ""));
  return params.get("error_description") ? "Você não tem acesso a este sistema." : null;
}

export function LoginScreen({ busy = false, message, children }: LoginScreenProps) {
  const { signIn } = useAuth();
  const [error, setError] = useState<string | null>(readRedirectError);
  const [redirecting, setRedirecting] = useState(false);

  const handleSignIn = async () => {
    setError(null);
    setRedirecting(true);
    const failure = await signIn();
    // Sem erro, o navegador segue para o Google e esta tela some.
    if (failure) {
      setError(failure);
      setRedirecting(false);
    }
  };

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>Checklist de testes · iPhone</h1>
        {busy ? (
          <p className={styles.text}>Carregando…</p>
        ) : (
          <>
            <p className={styles.text}>{message ?? "Entre com a sua conta Google para continuar."}</p>
            {!message && (
              <Button onClick={() => void handleSignIn()} disabled={redirecting}>
                {redirecting ? "Abrindo o Google…" : "Entrar com Google"}
              </Button>
            )}
            {children}
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
