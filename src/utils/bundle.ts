/**
 * Caminho do script principal (ex.: "/assets/index-Clt2s-uh.js") dentro de um HTML do app.
 * Cada publicação gera um nome novo, então comparar os nomes mostra se há versão nova.
 * No desenvolvimento não há esse arquivo, e o resultado é null.
 */
export function bundlePath(html: string): string | null {
  const match = /<script[^>]*\ssrc="([^"]*\/assets\/[^"]+\.js)"/.exec(html);
  if (!match?.[1]) return null;
  try {
    return new URL(match[1], "http://app.local").pathname;
  } catch {
    return null;
  }
}
