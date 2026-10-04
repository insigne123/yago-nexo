// Lectura de secretos. Los secretos de las funciones Edge son de todo el proyecto de Supabase,
// que es compartido con otro producto: por eso se busca primero la variante con prefijo
// NEXO_SD_ (por ejemplo NEXO_SD_RESEND_API_KEY) y, si no existe, el nombre genérico
// (RESEND_API_KEY). Así la mesa no pisa ni reutiliza por accidente secretos ajenos.
export function readSecret(env: (name: string) => string | undefined, name: string): string | undefined {
  const value = env(`NEXO_SD_${name}`) ?? env(name);
  return value !== undefined && value.trim() !== "" ? value : undefined;
}
