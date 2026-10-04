/** Une clases de Tailwind ignorando valores vacíos. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
