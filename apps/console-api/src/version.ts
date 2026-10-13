import { readFileSync } from "node:fs";

/**
 * Versión de Yago Nexo que informa la API (GET /api/v1/health, la Consola y el manifiesto de exportación): la del
 * package.json del paquete, que se sube junto con cada versión. Sirve igual desde src/ (desarrollo), desde dist/
 * (imagen) y en el laboratorio, que no fija NEXO_VERSION. En Kubernetes el chart la fija con su appVersion.
 */
export function versionNexo(archivo: URL = new URL("../package.json", import.meta.url)): string {
  try {
    const { version } = JSON.parse(readFileSync(archivo, "utf8")) as { version?: unknown };
    return typeof version === "string" && version ? version : "desconocida";
  } catch {
    return "desconocida";
  }
}
