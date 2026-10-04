// Lectura de secretos. Los secretos de las funciones Edge son de todo el proyecto de Supabase,
// que puede ser compartido con otro producto: por eso solo se usa la variante con prefijo
// NEXO_SD_ (por ejemplo NEXO_SD_RESEND_API_KEY). El nombre genérico (RESEND_API_KEY) se lee
// únicamente si NEXO_SD_USE_GENERIC_SECRETS=true, pensado para un proyecto dedicado a la mesa:
// en uno compartido, el genérico podría ser la cuenta de otro producto y la mesa enviaría
// correos o WhatsApp a su nombre sin que nadie lo note.
export function readSecret(env: (name: string) => string | undefined, name: string): string | undefined {
  const usable = (v: string | undefined) => (v !== undefined && v.trim() !== "" ? v : undefined);
  const own = usable(env(`NEXO_SD_${name}`));
  if (own !== undefined) return own;
  return env("NEXO_SD_USE_GENERIC_SECRETS") === "true" ? usable(env(name)) : undefined;
}
