import { describe, expect, it } from "vitest";
import { evaluarRecursos, UMBRALES_ENSAYO, UMBRALES_OFICIAL, type Recursos } from "./chequeo.js";
import { leerArgumentos, leerPerfil, normalizarId } from "./cli.js";
import { problemasModoOficial, type RevisionEtiqueta } from "./entorno.js";

const GB = 1024 ** 3;
const sana = (): Recursos => ({
  rutaDisco: "/release/evidencias",
  discoLibreBytes: 20 * GB,
  memoriaDisponibleBytes: 12 * GB,
  nucleos: 4,
  carga1: 0.4,
  modeloCpu: "CPU de prueba",
  ffmpegH264: true,
  navegador: true,
});

describe("chequeo previo (V10)", () => {
  it("una máquina sana pasa en modo oficial", () => {
    const r = evaluarRecursos(sana(), UMBRALES_OFICIAL);
    expect(r.ok).toBe(true);
    expect(r.problemas).toEqual([]);
    expect(r.resumen).toContain("20,0 GB libres");
  });

  it("aborta con menos de 8 GB libres en modo oficial y lo dice claro", () => {
    const r = evaluarRecursos({ ...sana(), discoLibreBytes: 7.5 * GB }, UMBRALES_OFICIAL);
    expect(r.ok).toBe(false);
    expect(r.problemas[0]).toMatch(/^disco: 7,5 GB libres en \/release\/evidencias; se exigen 8 GB/);
    expect(UMBRALES_OFICIAL.discoMinGB).toBe(8);
  });

  it("con el laboratorio arriba la carga habitual solo avisa; una sobrecarga clara aborta (oficial)", () => {
    const habitual = evaluarRecursos({ ...sana(), carga1: 3.2 }, UMBRALES_OFICIAL);
    expect(habitual.ok).toBe(true);
    expect(habitual.avisos.join()).toMatch(
      /CPU con carga 3.20 en 4 núcleos \(80 %\): la captura puede perder cuadros/,
    );
    const sobrecarga = evaluarRecursos({ ...sana(), carga1: 6.4 }, UMBRALES_OFICIAL);
    expect(sobrecarga.ok).toBe(false);
    expect(sobrecarga.problemas.join()).toMatch(
      /CPU ocupada: carga 6.40 en 4 núcleos \(160 %\); nadie debe compilar/,
    );
    const ensayo = evaluarRecursos({ ...sana(), carga1: 9 }, UMBRALES_ENSAYO);
    expect(ensayo.ok).toBe(true);
    expect(ensayo.avisos.join()).toMatch(/puede perder cuadros/);
  });

  it("memoria escasa: avisa bajo 3 GB y aborta bajo 1,5 GB (oficial)", () => {
    const poca = evaluarRecursos({ ...sana(), memoriaDisponibleBytes: 2 * GB }, UMBRALES_OFICIAL);
    expect(poca.ok).toBe(true);
    expect(poca.avisos.join()).toMatch(/memoria: 2,0 GB disponibles/);
    expect(evaluarRecursos({ ...sana(), memoriaDisponibleBytes: 1 * GB }, UMBRALES_OFICIAL).ok).toBe(false);
  });

  it("exige memoria, núcleos, ffmpeg con H.264 y Chromium", () => {
    const r = evaluarRecursos(
      { ...sana(), memoriaDisponibleBytes: 1 * GB, nucleos: 2, ffmpegH264: false, navegador: false },
      UMBRALES_OFICIAL,
    );
    expect(r.problemas).toHaveLength(4);
    expect(r.problemas.join("\n")).toMatch(/memoria[\s\S]*CPU: 2 núcleos[\s\S]*ffmpeg[\s\S]*Chromium/);
  });
});

describe("regla de versión del modo oficial (V10)", () => {
  const rev = (o: Partial<RevisionEtiqueta> = {}): RevisionEtiqueta => ({
    etiqueta: "v1.2.0",
    existe: true,
    commit: "a".repeat(40),
    commitCorto: "aaaaaaa",
    versionEtiqueta: "1.2.0",
    diferencias: [],
    sinConfirmar: [],
    head: "b".repeat(40),
    headCorto: "bbbbbbb",
    ...o,
  });

  it("graba si HEAD = etiqueta (+ herramientas), sin cambios sin confirmar y con la versión correcta", () => {
    expect(problemasModoOficial(rev(), "1.2.0")).toEqual([]);
  });

  it("se niega si la etiqueta no existe y sugiere --ensayo", () => {
    const p = problemasModoOficial(rev({ existe: false }), "1.1.0");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/la etiqueta v1.2.0 no existe.*--ensayo/);
  });

  it("se niega si el producto difiere de la etiqueta fuera de tools/evidencias y tools/aceptacion", () => {
    const p = problemasModoOficial(rev({ diferencias: ["apps/console-api/src/x.ts"] }), "1.2.0");
    expect(p[0]).toMatch(
      /HEAD difiere de v1.2.0 fuera de tools\/evidencias y tools\/aceptacion \(1 archivos: apps\/console-api\/src\/x.ts\)/,
    );
  });

  it("se niega con cambios sin confirmar o con una versión que no calza", () => {
    expect(
      problemasModoOficial(rev({ sinConfirmar: ["tools/evidencias/src/grabar.ts"] }), "1.2.0")[0],
    ).toMatch(/cambios sin confirmar/);
    const p = problemasModoOficial(rev({ versionEtiqueta: "1.1.0" }), "1.1.0");
    expect(p).toHaveLength(2);
  });
});

describe("argumentos de grabar", () => {
  it("normaliza los ids de las demostraciones", () => {
    expect(normalizarId("d04")).toBe("D-04");
    expect(normalizarId("D-4")).toBe("D-04");
    expect(normalizarId("bt5")).toBe("BT-005");
    expect(normalizarId("BT_049")).toBe("BT-049");
    expect(normalizarId("motor")).toBe("MOTOR");
  });

  it("--ensayo d04 (el ejemplo del plan)", () => {
    const a = leerArgumentos(["--ensayo", "d04"]);
    expect(a.ensayo).toBe(true);
    expect(a.ids).toEqual(["D-04"]);
    expect(a.etiqueta).toBe("v1.2.0");
    expect(a.ritmo).toBe(1);
    expect(a.rendimiento).toBeUndefined();
  });

  it("opciones con valor (separado o con =) y el «--» de pnpm", () => {
    const a = leerArgumentos([
      "--",
      "--etiqueta",
      "v1.2.1",
      "D-01",
      "--salida=/tmp/x",
      "--ritmo",
      "1.5",
      "--perfil",
      "1600x900",
      "BT-005",
      "--sin-compilar",
    ]);
    expect(a).toMatchObject({
      ensayo: false,
      etiqueta: "v1.2.1",
      salida: "/tmp/x",
      ritmo: 1.5,
      sinCompilar: true,
      ids: ["D-01", "BT-005"],
      perfil: { ancho: 1600, alto: 900, cps: 30 },
    });
  });

  it("--rendimiento con y sin segundos", () => {
    expect(leerArgumentos(["--rendimiento", "15"]).rendimiento).toBe(15);
    expect(leerArgumentos(["--rendimiento"]).rendimiento).toBe(20);
    expect(leerArgumentos(["--rendimiento", "d04"])).toMatchObject({ rendimiento: 20, ids: ["D-04"] });
  });

  it("perfil de captura alternativo", () => {
    expect(leerPerfil("1920x1080@25")).toEqual({ ancho: 1920, alto: 1080, cps: 25 });
    expect(leerPerfil("grande")).toBeUndefined();
    expect(() => leerArgumentos(["--perfil", "grande"])).toThrow(/ANCHOxALTO/);
  });
});
