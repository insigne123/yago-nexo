import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CASOS } from "./casos.js";
import { construirRegistro, numeroEjecucion, topologia, type Entorno } from "./registro.js";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const caso = (id: string) => CASOS.find((c) => c.id === id)!;
const entorno: Entorno = {
  ambiente: "Laboratorio",
  version: "Yago Nexo 1.2.0",
  commit: "abc1234",
  sbomSha256: null,
  configuracionSha256: "e".repeat(64),
  host: "lab",
  vcpu: 4,
  ramGB: 16,
  contenedores: {},
};

/** Script de pnpm que invoca el comando del caso, si es «pnpm --filter <paquete> <script>». */
function scriptDe(comando: string): { paquete: string; script: string } | undefined {
  const m = /^pnpm --filter (@nexo\/[\w-]+) ([\w:-]+)$/.exec(comando);
  return m ? { paquete: m[1]!, script: m[2]! } : undefined;
}
const DIRS: Record<string, string> = {
  "@nexo/lab-bootstrap": "tools/lab-bootstrap",
  "@nexo/aceptacion": "tools/aceptacion",
  "@nexo/respaldo": "tools/respaldo",
};

describe("casos nuevos de la versión 1.2.0", () => {
  it("PA-008 exige 422 (no 400), entrega única, rechazo 4xx sin reintentos y falla sin el servicio SOAP", () => {
    const c = caso("PA-008");
    expect(c.resultadoEsperado).toMatch(/422/);
    expect(c.resultadoEsperado).not.toMatch(/con 400/);
    expect(c.resultadoEsperado).toMatch(/servicio SOAP está detenido, el caso falla/);
    expect(c.componentes).toContain("concesiones-v1");
  });

  it("PA-009 concilia 100 mensajes por correlación (BT-009) y produce LAB-PA-009-01", () => {
    const c = caso("PA-009");
    expect(c.requisitos).toContain("BT-009");
    expect(c.comando).toBe("pnpm --filter @nexo/aceptacion conciliacion");
    expect(c.resultadoEsperado).toMatch(/100 enviados = 100 aceptados = 100 entregados, 0 duplicados/);
    const r = construirRegistro({
      caso: c,
      hito: "LAB",
      ejecucionN: 1,
      correlativo: 1,
      entorno,
      ejecucion: { inicio: new Date(0), fin: new Date(1000), codigoSalida: 0, salida: "" },
      evidencia: [],
      ejecutor: "E",
    });
    expect(r.numero).toBe("LAB-PA-009-01");
  });

  it("PA-053 cubre BT-053 con el rechazo de una clave ajena antes de escribir", () => {
    const c = caso("PA-053");
    expect(c.requisitos).toEqual(["BT-053"]);
    expect(c.comando).toBe("pnpm --filter @nexo/respaldo probar-clave-ajena");
    expect(c.resultadoEsperado).toMatch(/antes de escribir/);
  });

  it("PA-055 verifica la versión publicada con el script de release", () => {
    const c = caso("PA-055");
    expect(c.requisitos).toEqual(["BT-055", "BT-054", "BT-048"]);
    expect(c.titulo).toBe("SBOM, firmas y tabla de vulnerabilidades de la versión publicada");
    expect(c.comando).toBe("tools/release/verificar-version.sh 1.2.0");
    expect(existsSync(resolve(raiz, "tools/release/verificar-version.sh"))).toBe(true);
    expect(topologia(c, {})).toContain("GHCR (servicio externo al laboratorio)");
    expect(topologia(c, {}).some((t) => t.includes("no está en ejecución"))).toBe(false);
  });

  it("el script de pnpm de cada caso existe en el paquete que indica", () => {
    for (const c of CASOS) {
      const s = scriptDe(c.comando);
      if (!s) continue;
      const dir = DIRS[s.paquete];
      expect(dir, `${c.id}: paquete ${s.paquete}`).toBeDefined();
      const pkg = JSON.parse(readFileSync(resolve(raiz, dir!, "package.json"), "utf8")) as {
        name: string;
        scripts: Record<string, string>;
      };
      expect(pkg.name).toBe(s.paquete);
      expect(Object.keys(pkg.scripts), `${c.id}: script ${s.script}`).toContain(s.script);
    }
  });
});

describe("número de ejecución (LAB-PA-008-02)", () => {
  it("acepta un número para todos o una lista por caso; los demás quedan en 1", () => {
    expect(numeroEjecucion(undefined, "PA-008")).toBe(1);
    expect(numeroEjecucion("", "PA-008")).toBe(1);
    expect(numeroEjecucion("2", "PA-020")).toBe(2);
    expect(numeroEjecucion("PA-008=2, PA-009=1", "PA-008")).toBe(2);
    expect(numeroEjecucion("PA-008=2,PA-009=1", "PA-009")).toBe(1);
    expect(numeroEjecucion("PA-008=2", "PA-018")).toBe(1);
  });

  it("rechaza valores inválidos", () => {
    expect(() => numeroEjecucion("0", "PA-008")).toThrow(/entre 1 y 99/);
    expect(() => numeroEjecucion("PA-008=dos", "PA-008")).toThrow(/entre 1 y 99/);
    expect(() => numeroEjecucion("PA-008:2", "PA-008")).toThrow(/CASO=número/);
  });

  it("el número de ejecución llega al número de registro", () => {
    const r = construirRegistro({
      caso: caso("PA-008"),
      hito: "LAB",
      ejecucionN: numeroEjecucion("PA-008=2", "PA-008"),
      correlativo: 1,
      entorno,
      ejecucion: { inicio: new Date(0), fin: new Date(1000), codigoSalida: 0, salida: "" },
      evidencia: [],
      ejecutor: "E",
    });
    expect(r.numero).toBe("LAB-PA-008-02");
  });
});
