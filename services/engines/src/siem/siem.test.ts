import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@nexo/shared";
import { frame, ndjson, parseDestinations, priority, syslog5424 } from "./format.js";

const ev: AuditEvent = {
  id: "0b6c9f3e-2b1a-4c47-9d7e-1f2a3b4c5d6e",
  ts: "2026-10-04T08:30:00.123Z",
  seq: 42,
  source: "consola",
  actor: 'luis "aprobador"',
  actorType: "usuario",
  action: "anomalias.bloqueo.aprobar",
  resource: "anomalia/abc]def",
  result: "exito",
  prevHash: "a".repeat(64),
  hash: "b".repeat(64),
};

describe("syslog RFC 5424", () => {
  it("arma cabecera, datos estructurados escapados y el evento completo en JSON", () => {
    const m = syslog5424(ev, { hostname: "motores-1", appName: "nexo", pen: 32473 });
    expect(m.startsWith("<109>1 2026-10-04T08:30:00.123Z motores-1 nexo - anomalias.bloqueo.aprobar [nexo@32473 seq=\"42\"")).toBe(true);
    expect(m).toContain('actor="luis \\"aprobador\\""');
    expect(m).toContain('recurso="anomalia/abc\\]def"');
    expect(JSON.parse(m.slice(m.indexOf("] ") + 2))).toMatchObject({ seq: 42, hash: "b".repeat(64) });
  });

  it("la severidad sigue al resultado", () => {
    expect(priority("exito")).toBe(109);
    expect(priority("rechazado")).toBe(108);
    expect(priority("error")).toBe(107);
  });

  it("encuadra por conteo de octetos (bytes, no caracteres) o por salto de línea", () => {
    expect(frame("ñandú", "octetos").toString()).toBe("7 ñandú");
    expect(frame("a\nb", "lf").toString()).toBe("a b\n");
  });
});

describe("destinos", () => {
  it("interpreta syslog TCP, syslog TLS y HTTP sin guardar credenciales en la llave", () => {
    const d = parseDestinations("syslog+tcp://fluent-bit:5140?encuadre=lf, syslog+tls://siem.subtel.invalid, https://usuario:clave@colector.invalid/hec");
    expect(d.map((x) => [x.kind, x.key, x.port, x.framing])).toEqual([
      ["syslog", "syslog+tcp://fluent-bit:5140", 5140, "lf"],
      ["syslog", "syslog+tls://siem.subtel.invalid", 6514, "octetos"],
      ["http", "https://colector.invalid/hec", undefined, undefined],
    ]);
  });

  it("exige conteo de octetos sobre TLS", () => {
    expect(() => parseDestinations("syslog+tls://siem:6514?encuadre=lf")).toThrow(/RFC 5425/);
  });

  it("NDJSON: un evento por línea", () => {
    expect(ndjson([ev, { ...ev, seq: 43 }]).trim().split("\n")).toHaveLength(2);
  });
});
