import { useEffect, useState } from "react";
import { bundlePath } from "../utils/bundle";

const CHECK_EVERY_MS = 60_000;

/** Script principal que esta página carregou, ou null no desenvolvimento. */
function loadedBundle(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return script ? bundlePath(`<script src="${script.getAttribute("src") ?? ""}">`) : null;
}

/**
 * Avisa quando saiu uma versão nova do sistema: busca o HTML mais recente (sem cache)
 * e compara o script principal com o que esta página está rodando. Confere a cada minuto
 * e sempre que a pessoa volta para a aba.
 */
export function useUpdateAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const current = loadedBundle();
    if (!current) return; // desenvolvimento: não há o que comparar
    let active = true;

    const check = async () => {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}?check=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const latest = bundlePath(await response.text());
        if (active && latest && latest !== current) setAvailable(true);
      } catch {
        /* sem rede: tenta de novo na próxima */
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return available;
}
