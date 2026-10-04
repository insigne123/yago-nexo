import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizarConfig } from "./config.js";
import { comandoPg } from "./ejecucion.js";

const archivo = "/repo/tools/respaldo/respaldo.config.example.json";
const ejemplo: unknown = JSON.parse(
  readFileSync(new URL("../respaldo.config.example.json", import.meta.url), "utf8"),
);
const opciones = (env: NodeJS.ProcessEnv = {}) => ({ archivo, env, cwd: "/trabajo" });

describe("configuración", () => {
  it("la del laboratorio es válida y resuelve rutas desde la carpeta del archivo", () => {
    const c = normalizarConfig(ejemplo, opciones());
    expect(c.modo).toBe("docker");
    expect(c.destino).toBe("/repo/release/respaldos");
    expect(c.clave).toBe("/repo/deploy/compose/respaldo-lab.key");
    expect(c.generarClaveSiFalta).toBe(true);
    expect(c.retencion).toEqual({ conservar: 7, maximoDias: 35 });
    expect(c.docker).toEqual({ imagen: "postgres:16-alpine", red: "nexo-lab_default" });
    expect(c.servidores.map((s) => s.nombre)).toEqual(["principal", "keycloak"]);
    expect(c.servidores[0]).toMatchObject({
      bases: "todas",
      cliente: { host: "127.0.0.1", puerto: 15432 },
      tls: "desactivado",
      globales: true,
    });
  });

  it("las variables de entorno sobrescriben el archivo (rutas relativas a la carpeta actual)", () => {
    const c = normalizarConfig(
      ejemplo,
      opciones({
        NEXO_RESPALDO_MODO: "local",
        NEXO_RESPALDO_DESTINO: "respaldos",
        NEXO_RESPALDO_CLAVE: "/run/secrets/respaldo.key",
        NEXO_RESPALDO_CONSERVAR: "14",
        NEXO_RESPALDO_MAXIMO_DIAS: "0",
        NEXO_RESPALDO_IMAGEN: "postgres:16.15-alpine",
        NEXO_RESPALDO_BINARIOS: "/usr/lib/postgresql/16/bin",
      }),
    );
    expect(c.modo).toBe("local");
    expect(c.destino).toBe("/trabajo/respaldos");
    expect(c.clave).toBe("/run/secrets/respaldo.key");
    // Con la clave indicada por el entorno (producción) nunca se genera una nueva.
    expect(c.generarClaveSiFalta).toBe(false);
    expect(c.retencion).toEqual({ conservar: 14, maximoDias: null });
    expect(c.restauracion.imagen).toBe("postgres:16.15-alpine");
    expect(c.local.binarios).toBe("/usr/lib/postgresql/16/bin");
  });

  it("valida lo esencial con mensajes claros", () => {
    const servidor = { nombre: "principal", host: "db", usuario: "postgres", claveEnv: "PG" };
    expect(() => normalizarConfig({ modo: "local", servidores: [] }, opciones())).toThrow(
      /al menos un servidor/,
    );
    expect(() => normalizarConfig({ modo: "docker", servidores: [servidor] }, opciones())).toThrow(
      /docker.red/,
    );
    expect(() => normalizarConfig({ modo: "nube", servidores: [servidor] }, opciones())).toThrow(/modo/);
    expect(() =>
      normalizarConfig({ modo: "local", servidores: [{ ...servidor, claveEnv: undefined }] }, opciones()),
    ).toThrow(/claveEnv/);
    expect(() =>
      normalizarConfig({ modo: "local", servidores: [{ ...servidor, nombre: "Mal Nombre" }] }, opciones()),
    ).toThrow(/nombre/);
    expect(() => normalizarConfig({ modo: "local", servidores: [servidor, servidor] }, opciones())).toThrow(
      /dos servidores/,
    );
    expect(() =>
      normalizarConfig({ modo: "local", servidores: [{ ...servidor, tls: "verificar" }] }, opciones()),
    ).toThrow(/ca/);
    expect(() =>
      normalizarConfig({ modo: "local", retencion: { conservar: 0 }, servidores: [servidor] }, opciones()),
    ).toThrow(/conservar/);
    expect(() =>
      normalizarConfig(
        { modo: "local", servidores: [servidor] },
        opciones({ NEXO_RESPALDO_CONSERVAR: "siete" }),
      ),
    ).toThrow(/NEXO_RESPALDO_CONSERVAR/);
  });
});

describe("invocación de pg_dump", () => {
  const c = normalizarConfig(ejemplo, opciones());
  const principal = c.servidores[0]!;

  it("modo docker: contenedor efímero en la red del laboratorio y contraseña fuera de la línea de comandos", () => {
    const cmd = comandoPg("pg_dump", ["--dbname", "nexo", "--format=custom"], principal, c, "s3cr3t", {});
    expect(cmd.comando).toBe("docker");
    expect(cmd.contenedor).toMatch(/^nexo-respaldo-volcado-principal-[0-9a-f]{8}$/);
    expect(cmd.args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(cmd.args).toContain("nexo-lab_default");
    expect(cmd.args.join(" ")).not.toContain("s3cr3t");
    expect(cmd.args).toContain("PGPASSWORD");
    expect(cmd.env.PGPASSWORD).toBe("s3cr3t");
    expect(cmd.args).not.toContain("-p");
    expect(cmd.args.slice(cmd.args.indexOf("postgres:16-alpine"))).toEqual([
      "postgres:16-alpine",
      "pg_dump",
      "--host",
      "postgres",
      "--port",
      "5432",
      "--username",
      "postgres",
      "--no-password",
      "--dbname",
      "nexo",
      "--format=custom",
    ]);
  });

  it("modo local: binarios de la carpeta configurada y TLS por variables de libpq", () => {
    const local = normalizarConfig(
      ejemplo,
      opciones({ NEXO_RESPALDO_MODO: "local", NEXO_RESPALDO_BINARIOS: "/opt/pg16/bin" }),
    );
    const cmd = comandoPg(
      "pg_dumpall",
      ["--globals-only"],
      { ...principal, tls: "requerido" },
      local,
      "s3cr3t",
      { PATH: "/usr/bin" },
    );
    expect(cmd.comando).toBe("/opt/pg16/bin/pg_dumpall");
    expect(cmd.contenedor).toBeUndefined();
    expect(cmd.env).toMatchObject({ PATH: "/usr/bin", PGPASSWORD: "s3cr3t", PGSSLMODE: "require" });
    expect(cmd.args.join(" ")).not.toContain("s3cr3t");
  });
});
