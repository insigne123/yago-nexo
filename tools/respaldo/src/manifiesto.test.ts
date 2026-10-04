import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { huellaClave } from "./cifrado.js";
import {
  artefactos,
  construirManifiesto,
  fechaDeId,
  idDeFecha,
  jsonCanonico,
  nombreArchivo,
  verificarManifiesto,
  type BaseRespaldada,
  type DatosManifiesto,
} from "./manifiesto.js";

const clave = randomBytes(32);

function base(servidor: string, nombre: string, filas: number[]): BaseRespaldada {
  return {
    nombre,
    archivo: `${servidor}/${nombre}.pgdump.enc`,
    bytes: 1000,
    bytesSinCifrar: 956,
    sha256: "a".repeat(64),
    snapshot: "00000003-0000001B-1",
    instanteSnapshot: "2026-10-04T10:00:00.000000Z",
    lsn: "0/1A2B3C4",
    duracionMs: 120,
    tablas: filas.map((f, i) => ({ esquema: "public", tabla: `t${i}`, filas: f, huella: String(f * 7) })),
    totalFilas: filas.reduce((a, b) => a + b, 0),
    sondas: {},
  };
}

function datos(): DatosManifiesto {
  return {
    id: "20261004T100000Z",
    herramienta: { nombre: "@nexo/respaldo", version: "1.0.0" },
    modo: "docker",
    inicio: "2026-10-04T10:00:00.000Z",
    fin: "2026-10-04T10:00:05.000Z",
    duracionMs: 5000,
    versionPgDump: "pg_dump (PostgreSQL) 16.15",
    huellaContenido: true,
    cifrado: { tamanoBloque: 1048576, huellaClave: huellaClave(clave) },
    servidores: [
      {
        nombre: "principal",
        versionPg: "16.15",
        versionPgNum: 160015,
        globales: {
          archivo: "principal/globales.sql.enc",
          bytes: 300,
          bytesSinCifrar: 256,
          sha256: "b".repeat(64),
          instante: "2026-10-04T10:00:00.000Z",
        },
        bases: [base("principal", "apim_db", [10, 0, 5]), base("principal", "nexo", [227])],
      },
      {
        nombre: "keycloak",
        versionPg: "16.15",
        versionPgNum: 160015,
        globales: null,
        bases: [base("keycloak", "keycloak", [1, 2, 3, 4])],
      },
    ],
  };
}

describe("manifiesto", () => {
  it("calcula los totales y describe el cifrado", () => {
    const m = construirManifiesto(datos(), clave);
    expect(m.formato).toBe("nexo-respaldo/1");
    expect(m.totales).toEqual({ servidores: 2, bases: 3, tablas: 8, filas: 252, bytes: 3300 });
    expect(m.cifrado).toMatchObject({
      algoritmo: "AES-256-GCM",
      esquema: "NEXORSP1",
      kdf: "HKDF-SHA256",
      tamanoBloque: 1048576,
    });
    expect(artefactos(m).map((a) => a.archivo)).toEqual([
      "principal/globales.sql.enc",
      "principal/apim_db.pgdump.enc",
      "principal/nexo.pgdump.enc",
      "keycloak/keycloak.pgdump.enc",
    ]);
  });

  it("se verifica después de escribirlo y leerlo como JSON", () => {
    const m = construirManifiesto(datos(), clave);
    const leido: unknown = JSON.parse(JSON.stringify(m, null, 2));
    expect(verificarManifiesto(leido, clave, huellaClave(clave)).id).toBe("20261004T100000Z");
  });

  it("detecta un conteo de filas modificado", () => {
    const m = JSON.parse(JSON.stringify(construirManifiesto(datos(), clave)));
    m.servidores[0].bases[1].tablas[0].filas = 226;
    expect(() => verificarManifiesto(m, clave, huellaClave(clave))).toThrow(/fue modificado/);
  });

  it("detecta un SHA-256 reemplazado (para ocultar un archivo alterado)", () => {
    const m = JSON.parse(JSON.stringify(construirManifiesto(datos(), clave)));
    m.servidores[1].bases[0].sha256 = "c".repeat(64);
    expect(() => verificarManifiesto(m, clave, huellaClave(clave))).toThrow(/fue modificado/);
  });

  it("avisa si el respaldo es de otra clave, sin intentar descifrar", () => {
    const otra = randomBytes(32);
    const m = construirManifiesto(datos(), clave);
    expect(() => verificarManifiesto(m, otra, huellaClave(otra))).toThrow(/otra clave/);
  });

  it("rechaza lo que no es un manifiesto firmado", () => {
    expect(() => verificarManifiesto(null, clave, huellaClave(clave))).toThrow(/objeto/);
    expect(() => verificarManifiesto({ formato: "otro" }, clave, huellaClave(clave))).toThrow(/formato/);
    const { firma: _firma, ...sinFirma } = construirManifiesto(datos(), clave);
    expect(() => verificarManifiesto(sinFirma, clave, huellaClave(clave))).toThrow(/no está firmado/);
  });

  it("JSON canónico: no depende del orden de las claves y omite undefined", () => {
    expect(jsonCanonico({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(jsonCanonico({ a: 1, b: 2 })).toBe(jsonCanonico({ b: 2, a: 1 }));
  });
});

describe("identificadores y nombres de archivo", () => {
  it("id = instante UTC, ordenable y reversible", () => {
    const f = new Date("2026-10-04T16:30:12.345Z");
    expect(idDeFecha(f)).toBe("20261004T163012Z");
    expect(fechaDeId("20261004T163012Z")?.toISOString()).toBe("2026-10-04T16:30:12.000Z");
    expect(fechaDeId(".20261004T163012Z.parcial")).toBeUndefined();
    expect(fechaDeId("20261340T000000Z")).toBeUndefined();
  });

  it("nombres de base seguros como nombre de archivo, sin colisiones", () => {
    expect(nombreArchivo("apim_db")).toBe("apim_db");
    expect(nombreArchivo("../etc")).not.toContain("/");
    expect(nombreArchivo("a b")).not.toBe(nombreArchivo("a_b"));
    expect(nombreArchivo("a b")).toMatch(/^a_b-[0-9a-f]+$/);
  });
});
