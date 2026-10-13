import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Ejecucion from "./ejecucion.js";

// Cualquier proceso externo (docker run del servidor temporal, psql, pg_restore) queda registrado: la prueba
// exige que con otra clave no se lance ninguno.
const procesos = vi.hoisted(() => [] as string[][]);
vi.mock("./ejecucion.js", async (original) => {
  const real = await original<typeof Ejecucion>();
  const registrar = (comando: string, args: string[]) => {
    procesos.push([comando, ...args]);
    return { codigo: 0, salida: "", error: "" };
  };
  return {
    ...real,
    ejecutar: vi.fn(async (c: string, a: string[]) => registrar(c, a)),
    ejecutarOk: vi.fn(async (c: string, a: string[]) => registrar(c, a).salida),
    lanzar: vi.fn((c: string, a: string[]) => {
      registrar(c, a);
      throw new Error("no se debía lanzar un proceso");
    }),
    eliminarContenedor: vi.fn(async () => undefined),
  };
});

const { probarClaveAjena, diferencias } = await import("./clave-ajena.js");
const { restaurar } = await import("./restaurar.js");
const { cifrarBuffer, huellaClave } = await import("./cifrado.js");
const { construirManifiesto, ARCHIVO_MANIFIESTO } = await import("./manifiesto.js");
const { normalizarConfig } = await import("./config.js");

const clave = randomBytes(32);
const ID = "20261012T030000Z";
let dir: string;

async function respaldoEnDisco(): Promise<string> {
  const carpeta = join(dir, "respaldos", ID);
  await mkdir(join(carpeta, "principal"), { recursive: true });
  const cifrado = await cifrarBuffer(clave, Buffer.from("volcado sintético"));
  await writeFile(join(carpeta, "principal", "nexo.pgdump.enc"), cifrado);
  const m = construirManifiesto(
    {
      id: ID,
      herramienta: { nombre: "@nexo/respaldo", version: "1.2.0" },
      modo: "docker",
      inicio: "2026-10-12T03:00:00.000Z",
      fin: "2026-10-12T03:00:05.000Z",
      duracionMs: 5000,
      versionPgDump: "pg_dump (PostgreSQL) 16.15",
      huellaContenido: true,
      cifrado: { tamanoBloque: 1048576, huellaClave: huellaClave(clave) },
      servidores: [
        {
          nombre: "principal",
          versionPg: "16.15",
          versionPgNum: 160015,
          globales: null,
          bases: [
            {
              nombre: "nexo",
              archivo: "principal/nexo.pgdump.enc",
              bytes: cifrado.length,
              bytesSinCifrar: 17,
              sha256: "0".repeat(64),
              snapshot: "00000003-0000001B-1",
              instanteSnapshot: "2026-10-12T03:00:00.000000Z",
              lsn: "0/1A2B3C4",
              duracionMs: 10,
              tablas: [],
              totalFilas: 0,
              sondas: {},
            },
          ],
        },
      ],
    },
    clave,
  );
  await writeFile(join(carpeta, ARCHIVO_MANIFIESTO), JSON.stringify(m, null, 2));
  // Informe de la última prueba válida: no debe sobrescribirse con un intento rechazado.
  await writeFile(join(carpeta, "informe-restauracion.json"), '{"resultado":"exitosa"}\n');
  return carpeta;
}

function config(rutaClave: string) {
  return normalizarConfig(
    {
      modo: "docker",
      docker: { red: "nexo-lab_default" },
      destino: join(dir, "respaldos"),
      clave: rutaClave,
      servidores: [
        {
          nombre: "principal",
          host: "postgres",
          puerto: 5432,
          usuario: "nexo",
          claveEnv: "PGPASSWORD_PRUEBA",
        },
      ],
    },
    { archivo: join(dir, "respaldo.config.json"), env: {}, cwd: dir },
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nexo-respaldo-prueba-"));
  procesos.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("restaurar con otra clave (1-12)", () => {
  it("restaurar() rechaza la clave distinta antes de lanzar procesos y sin escribir en la carpeta del respaldo", async () => {
    const carpeta = await respaldoEnDisco();
    const otra = join(dir, "otra.key");
    await writeFile(otra, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    await expect(restaurar(config(otra), { respaldo: ID }, () => undefined)).rejects.toThrow(
      /se cifró con otra clave/,
    );
    expect(procesos).toEqual([]);
    expect(await readFile(join(carpeta, "informe-restauracion.json"), "utf8")).toBe(
      '{"resultado":"exitosa"}\n',
    );
  });

  it("el caso de aceptación aprueba: rechazo por huella, archivos intactos y ningún servidor temporal", async () => {
    await respaldoEnDisco();
    const lineas: string[] = [];
    const r = await probarClaveAjena(config(join(dir, "no-se-lee.key")), {}, (m) => lineas.push(m), {
      restaurar,
      contenedoresPrueba: async () => [],
    });
    expect(r.ok).toBe(true);
    expect(r.respaldo).toBe(ID);
    expect(r.rechazo).toMatch(new RegExp(`huella ${huellaClave(clave)}.*huella ${r.huellaClaveAjena}`));
    expect(r.archivosAntes).toBe(3);
    expect(r.cambios).toEqual([]);
    expect(procesos).toEqual([]);
    expect(lineas[0]).toMatch(/3 archivos/);
  });

  it("el caso falla si la restauración no rechaza, si escribe en el respaldo o si crea un servidor temporal", async () => {
    const carpeta = await respaldoEnDisco();
    const cfg = config(join(dir, "no-se-lee.key"));
    const acepta = await probarClaveAjena(cfg, {}, () => undefined, {
      restaurar: (async () => ({
        informe: { resultado: "fallida" },
        carpeta,
      })) as unknown as typeof restaurar,
      contenedoresPrueba: async () => [],
    });
    expect(acepta.ok).toBe(false);
    expect(acepta.motivos[0]).toMatch(/no rechazó/);

    let llamadas = 0;
    const escribe = await probarClaveAjena(cfg, {}, () => undefined, {
      restaurar: (async (...a: Parameters<typeof restaurar>) => {
        await writeFile(join(carpeta, ".en-prueba"), "1");
        return restaurar(...a);
      }) as typeof restaurar,
      contenedoresPrueba: async () => (llamadas++ === 0 ? [] : ["nexo-respaldo-prueba-principal-abc"]),
    });
    expect(escribe.ok).toBe(false);
    expect(escribe.cambios).toEqual(["agregado .en-prueba"]);
    expect(escribe.contenedoresNuevos).toEqual(["nexo-respaldo-prueba-principal-abc"]);
  });

  it("compara carpetas por SHA-256: agregados, cambiados y quitados", () => {
    const a = new Map([
      ["x", "1"],
      ["y", "2"],
    ]);
    expect(
      diferencias(
        a,
        new Map([
          ["x", "1"],
          ["y", "3"],
          ["z", "4"],
        ]),
      ),
    ).toEqual(["agregado z", "cambiado y"]);
    expect(diferencias(a, new Map([["x", "1"]]))).toEqual(["quitado y"]);
  });
});
