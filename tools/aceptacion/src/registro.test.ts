import { describe, expect, it } from "vitest";
import { CASOS } from "./casos.js";
import { construirRegistro, filas, markdown, resumenSalida, sha256, topologia, type Entorno } from "./registro.js";

const entorno: Entorno = {
  ambiente: "Laboratorio",
  version: "Yago Nexo 1.0.0",
  commit: "abc1234",
  sbomSha256: "f".repeat(64),
  configuracionSha256: "e".repeat(64),
  host: "lab",
  vcpu: 4,
  ramGB: 15,
  contenedores: { "nexo-lab-apim-1": "nexo-lab/apim:4.7.0", "nexo-lab-keycloak-1": "keycloak/keycloak:26.8" },
};
const caso = CASOS.find((c) => c.id === "PA-005")!;
const ejecucion = (codigo: number) => ({ inicio: new Date("2026-10-04T12:00:00Z"), fin: new Date("2026-10-04T12:00:42.5Z"), codigoSalida: codigo, salida: "paso 1\n\x1b[32mlisto\x1b[0m\n" });

describe("registro de aceptación", () => {
  it("tiene los 16 campos de las Bases además de los de control y resultado", () => {
    const r = construirRegistro({ caso, hito: "H1", ejecucionN: 1, correlativo: 1, entorno, ejecucion: ejecucion(0), evidencia: [], ejecutor: "Ejecutor" });
    const campos = filas(r).map(([c]) => c);
    for (const c of ["Ambiente", "Versión", "Topología", "Recursos", "Configuración", "Datos", "Condiciones previas", "Pasos", "Duración", "Carga", "Resultado esperado", "Tolerancia", "Ejecutor", "Testigo", "Aprobador", "Evidencia"]) {
      expect(campos).toContain(c);
    }
    expect(r.numero).toBe("H1-PA-005-01");
    expect(r.duracion.segundos).toBe(42.5);
    expect(r.estado).toBe("Aprobada");
    expect(r.testigo).toBe("Pendiente de firma");
  });

  it("una verificación con código distinto de cero queda rechazada con defecto", () => {
    const r = construirRegistro({ caso, hito: "H1", ejecucionN: 2, correlativo: 1, entorno, ejecucion: ejecucion(1), evidencia: [], ejecutor: "Ejecutor" });
    expect(r.estado).toBe("Rechazada");
    expect(r.defectos).toMatch(/código 1/);
    expect(r.numero).toBe("H1-PA-005-02");
  });

  it("la topología indica qué componentes no están en ejecución", () => {
    const t = topologia(caso, entorno.contenedores);
    expect(t).toContain("apim (nexo-lab/apim:4.7.0)");
    expect(t.find((x) => x.startsWith("concesiones-v1"))).toMatch(/no está en ejecución/);
  });

  it("el resumen de la salida quita colores y bordes de tabla", () => {
    expect(resumenSalida("┌──┐\n│ a │\n\x1b[31mfalla\x1b[0m\n")).toBe("│ a │\nfalla");
  });

  it("markdown escapa barras y saltos de línea en las celdas", () => {
    const r = construirRegistro({ caso, hito: "H1", ejecucionN: 1, correlativo: 1, entorno, ejecucion: ejecucion(0), evidencia: [{ archivo: "a|b.txt", sha256: sha256("x") }], ejecutor: "E" });
    const md = markdown(r);
    expect(md).toContain("a\\|b.txt");
    expect(md).not.toMatch(/\| Pasos \| [^\n]*\n[^|]/);
  });

  it("cada caso del catálogo tiene requisitos, comando y resultado esperado, sin identificadores repetidos", () => {
    const ids = CASOS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CASOS) {
      expect(c.requisitos.length).toBeGreaterThan(0);
      expect(c.comando.length).toBeGreaterThan(0);
      expect(c.resultadoEsperado.length).toBeGreaterThan(0);
    }
  });
});
