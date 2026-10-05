export function formatDateTime(value?: string | Date): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  return (
    date.toLocaleDateString("pt-BR") +
    " " +
    date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
  );
}
