import type { AuditEvent } from "@nexo/shared";

/**
 * Formatos de salida hacia el SIEM: syslog RFC 5424 (con encuadre RFC 6587 por conteo de octetos o salto
 * de línea) y NDJSON para colectores HTTP. Cada evento viaja completo, con su secuencia y sus hashes, para
 * que el SIEM pueda verificar la cadena y descartar duplicados (la entrega es "al menos una vez").
 */
export interface SyslogOptions {
  hostname: string;
  appName: string;
  /** Número de empresa privada (IANA) del identificador de datos estructurados. 32473 es el de documentación. */
  pen: number;
}

/** Facilidad 13 (auditoría de registros); severidad según el resultado del evento. */
export function priority(result: AuditEvent["result"]): number {
  const severity = result === "exito" ? 5 : result === "rechazado" ? 4 : 3;
  return 13 * 8 + severity;
}

const printable = (s: string, max: number) => (s.replace(/[^\x21-\x7E]/g, "_").slice(0, max) || "-");
const sdValue = (s: string) => s.replace(/[\\"\]]/g, (c) => `\\${c}`);

export function syslog5424(e: AuditEvent, o: SyslogOptions): string {
  const sd =
    `[nexo@${o.pen} seq="${e.seq}" hash="${e.hash}" prev="${e.prevHash}" actor="${sdValue(e.actor)}" tipoActor="${e.actorType}" ` +
    `resultado="${e.result}"${e.resource ? ` recurso="${sdValue(e.resource)}"` : ""}${e.sourceIp ? ` ip="${sdValue(e.sourceIp)}"` : ""}]`;
  return `<${priority(e.result)}>1 ${e.ts} ${printable(o.hostname, 255)} ${printable(o.appName, 48)} - ${printable(e.action, 32)} ${sd} ${JSON.stringify(e)}`;
}

export type Framing = "octetos" | "lf";

/** RFC 6587: "octetos" antepone el largo en bytes (obligatorio sobre TLS, RFC 5425); "lf" termina en salto de línea. */
export function frame(message: string, framing: Framing): Buffer {
  if (framing === "lf") return Buffer.from(`${message.replace(/\n/g, " ")}\n`, "utf8");
  const body = Buffer.from(message, "utf8");
  return Buffer.concat([Buffer.from(`${body.length} `, "ascii"), body]);
}

export function ndjson(events: readonly AuditEvent[]): string {
  return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

export interface Destination {
  /** Identificador estable del destino (para su cursor): la URL sin credenciales. */
  key: string;
  kind: "syslog" | "http";
  host?: string;
  port?: number;
  tls?: boolean;
  framing?: Framing;
  url?: string;
}

/**
 * Destinos desde NEXO_SIEM_DESTINOS, separados por coma:
 *   syslog+tcp://host:514?encuadre=lf · syslog+tls://host:6514 · https://colector/ruta
 */
export function parseDestinations(spec: string): Destination[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const u = new URL(raw);
      if (u.protocol === "syslog+tcp:" || u.protocol === "syslog+tls:") {
        const tls = u.protocol === "syslog+tls:";
        const framing = (u.searchParams.get("encuadre") as Framing | null) ?? (tls ? "octetos" : "lf");
        if (framing !== "octetos" && framing !== "lf") throw new Error(`Encuadre inválido en ${raw}: use octetos o lf`);
        if (tls && framing !== "octetos") throw new Error("Syslog sobre TLS exige encuadre por conteo de octetos (RFC 5425)");
        return { key: `${u.protocol}//${u.host}`, kind: "syslog" as const, host: u.hostname, port: Number(u.port || (tls ? 6514 : 514)), tls, framing };
      }
      if (u.protocol === "https:" || u.protocol === "http:") {
        const clean = new URL(raw);
        clean.username = "";
        clean.password = "";
        return { key: clean.toString(), kind: "http" as const, url: raw };
      }
      throw new Error(`Destino de SIEM no soportado: ${raw}`);
    });
}
