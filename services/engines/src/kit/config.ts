/** Configuración de los motores, solo por variables de entorno. Las credenciales no tienen valor por defecto. */
export const env = (k: string, d?: string): string => {
  const v = process.env[k] || d;
  if (v === undefined) throw new Error(`Falta la variable de entorno ${k}`);
  return v;
};
export const opt = (k: string): string | undefined => process.env[k] || undefined;
export const num = (k: string, d: number): number => {
  const v = process.env[k];
  if (!v) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`La variable ${k} debe ser numérica`);
  return n;
};
export const bool = (k: string, d = false): boolean => (process.env[k] ? process.env[k] === "true" : d);

/** Gateways de un ambiente: "Nombre:vhost,Nombre:vhost". */
export function gatewaysFor(environment: string): Array<{ name: string; vhost: string }> {
  const defaults: Record<string, string> = {
    dev: "Desarrollo:dev.nexo.lab",
    qa: "QA:qa.nexo.lab",
    prod: "Default:apim,Operadores:operadores.nexo.lab",
  };
  const raw = env(`NEXO_GATEWAYS_${environment.toUpperCase()}`, defaults[environment]);
  return raw
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => {
      const [name, vhost] = g.split(":");
      return { name: name!, vhost: vhost ?? "localhost" };
    });
}
