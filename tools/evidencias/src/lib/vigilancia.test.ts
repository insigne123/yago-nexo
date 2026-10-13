import { describe, expect, it } from "vitest";
import {
  buscarProhibidos,
  huellasConfiguradas,
  huellaTermino,
  HUELLAS_MOTOR,
  normalizar,
  Vigilante,
} from "./vigilancia.js";

// Los términos de prueba son inventados: la lista real vive en el motor solo como huellas SHA-256.
const FICTICIO = "Instituto Ficticio de Pruebas";

describe("normalizar y huellas", () => {
  it("normaliza a minúsculas, sin tildes y con un espacio entre palabras", () => {
    expect(normalizar("  Dirección   de  Prueba—Número 7! ")).toBe("direccion de prueba numero 7");
    expect(huellaTermino("Ñandú")).toBe(huellaTermino("nandu"));
    expect(huellaTermino("ÑANDÚ")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("el motor trae la institución compradora y el proceso de compra solo como huellas", () => {
    expect(HUELLAS_MOTOR.length).toBeGreaterThanOrEqual(3);
    for (const h of HUELLAS_MOTOR) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("agrega términos y huellas desde el entorno sin escribirlos en el repositorio", () => {
    const h = huellasConfiguradas({
      EVIDENCIAS_PROHIBIDOS: "Cliente Uno, Otro Cliente",
      EVIDENCIAS_PROHIBIDOS_HUELLAS: `${"a".repeat(64)},no-es-huella`,
    });
    expect(h.has(huellaTermino("cliente uno"))).toBe(true);
    expect(h.has(huellaTermino("otro cliente"))).toBe(true);
    expect(h.has("a".repeat(64))).toBe(true);
    expect(h.has("no-es-huella")).toBe(false);
    for (const m of HUELLAS_MOTOR) expect(h.has(m)).toBe(true);
  });
});

describe("buscarProhibidos", () => {
  const huellas = new Set([huellaTermino(FICTICIO), huellaTermino("XYZ")]);

  it("encuentra términos de 1 a 4 palabras con otra capitalización, tildes o signos", () => {
    const h = buscarProhibidos("Informe para el INSTITUTO ficticio de pruebas, versión final", huellas);
    expect(h).toHaveLength(1);
    expect(h[0]!.palabras).toBe(4);
    expect(buscarProhibidos("Sigla: x.y.z no, pero XYZ sí", huellas)).toHaveLength(1);
  });

  it("no da falsos positivos con palabras que solo contienen el término", () => {
    expect(buscarProhibidos("XYZetas y preXYZ no cuentan", huellas)).toHaveLength(0);
    expect(buscarProhibidos("", huellas)).toHaveLength(0);
  });
});

describe("Vigilante", () => {
  it("acumula infracciones con su origen", () => {
    const v = new Vigilante(new Set([huellaTermino("XYZ")]));
    expect(v.revisar("panel", "todo bien")).toBe(true);
    expect(v.revisar("terminal", "aparece XYZ aquí")).toBe(false);
    expect(v.infracciones).toHaveLength(1);
    expect(v.infracciones[0]).toMatch(/^terminal: /);
  });

  it("en revisiones periódicas no repite el mismo texto de la misma pantalla", () => {
    const v = new Vigilante(new Set([huellaTermino("XYZ")]));
    v.revisar("pantalla", "XYZ", true);
    v.revisar("pantalla", "XYZ", true);
    expect(v.infracciones).toHaveLength(1);
    v.revisar("pantalla", "otra cosa", true);
    v.revisar("pantalla", "XYZ", true);
    expect(v.infracciones).toHaveLength(2);
    expect(v.revisar("pantalla", undefined)).toBe(true);
  });
});
