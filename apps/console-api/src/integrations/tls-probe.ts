import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** Un intento de saludo TLS contra un canal. */
export interface TlsAttempt {
  ok: boolean;
  protocol?: string;
  cipher?: string;
  /** Código del error (p. ej., ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION, ECONNREFUSED o ETIMEDOUT). */
  error?: string;
}

/**
 * Saludo TLS. El intento «antiguo» ofrece solo TLS 1.0 y baja el nivel de seguridad de OpenSSL a 0: con el nivel
 * por omisión de OpenSSL 3, el propio cliente no puede ofrecer TLS 1.0 y el intento fallaría aunque el servidor
 * lo aceptara (un falso «rechazado»).
 */
export function tlsAttempt(
  host: string,
  port: number,
  kind: "moderno" | "tls10",
  timeoutMs = 4000,
): Promise<TlsAttempt> {
  const versions =
    kind === "tls10"
      ? ({ minVersion: "TLSv1", maxVersion: "TLSv1", ciphers: "DEFAULT@SECLEVEL=0" } as const)
      : ({ minVersion: "TLSv1.2", maxVersion: "TLSv1.3" } as const);
  return new Promise<TlsAttempt>((resolve) => {
    let done = false;
    const finish = (r: TlsAttempt) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const socket = tlsConnect(
      {
        host,
        port,
        ...(isIP(host) ? {} : { servername: host }),
        rejectUnauthorized: false,
        timeout: timeoutMs,
        ...versions,
      },
      () => {
        const cipher = socket.getCipher();
        finish({ ok: true, protocol: socket.getProtocol() ?? undefined, cipher: cipher?.name });
        socket.end();
      },
    );
    socket.on("error", (e: NodeJS.ErrnoException) => finish({ ok: false, error: e.code ?? e.message }));
    socket.on("timeout", () => {
      socket.destroy();
      finish({ ok: false, error: "ETIMEDOUT" });
    });
  });
}

/**
 * Señales de que fue el servidor el que rechazó el saludo TLS 1.0: una alerta TLS (protocol_version,
 * handshake_failure…), una versión que no ofrece o el corte de la conexión en pleno saludo. Los errores del
 * propio cliente (sin protocolos o cifrados que ofrecer) y los de red (conexión rechazada, sin respuesta) no
 * cuentan: con ellos no se sabe qué haría el servidor.
 */
const SERVER_REFUSAL = /ALERT|^ERR_SSL_WRONG_VERSION_NUMBER$|^ERR_SSL_UNSUPPORTED_PROTOCOL$|^ECONNRESET$/;

/**
 * ¿El canal rechaza TLS 1.0? true solo si el canal responde con TLS 1.2 o 1.3 y el servidor rechazó el saludo
 * TLS 1.0; false si lo aceptó; undefined («—» en la Consola) si no se pudo determinar.
 */
export function rejectsTls10(modern: TlsAttempt, legacy: TlsAttempt): boolean | undefined {
  if (!modern.ok) return undefined;
  if (legacy.ok) return false;
  return legacy.error && SERVER_REFUSAL.test(legacy.error) ? true : undefined;
}
