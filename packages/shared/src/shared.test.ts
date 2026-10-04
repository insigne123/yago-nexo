import { describe, expect, it } from "vitest";
import { AuditChain, verifyChain } from "./audit.js";
import { can, FOUR_EYES_ACTIONS, permissionMatrix, ROLES } from "./roles.js";
import { classifySeverity } from "./severity.js";
import { formatRut, isValidRut, rutDv, SyntheticData } from "./synthetic.js";

describe("cadena de auditoría", () => {
  const sample = (i: number) => ({
    source: "consola",
    actor: `usuario${i}@subtel.invalid`,
    actorType: "usuario" as const,
    action: "catalog.update",
    resource: `api/${i}`,
    result: "exito" as const,
    sourceIp: "10.0.0.1",
  });

  it("verifica una cadena íntegra", () => {
    const chain = new AuditChain();
    const events = [1, 2, 3].map((i) => chain.append(sample(i)));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(verifyChain(events)).toMatchObject({ ok: true, count: 3, lastSeq: 3 });
  });

  it("detecta un evento alterado", () => {
    const chain = new AuditChain();
    const events = [1, 2, 3].map((i) => chain.append(sample(i)));
    events[1] = { ...events[1]!, actor: "intruso" };
    expect(verifyChain(events)).toMatchObject({ ok: false, brokenAt: 2, reason: "hash" });
  });

  it("detecta un hueco en la secuencia", () => {
    const chain = new AuditChain();
    const events = [1, 2, 3].map((i) => chain.append(sample(i)));
    expect(verifyChain([events[0]!, events[2]!])).toMatchObject({ ok: false, reason: "secuencia" });
  });
});

describe("matriz rol-permiso", () => {
  it("el desarrollador no aprueba despliegues a producción", () => {
    expect(can(["desarrollador"], "rollout:create")).toBe(true);
    expect(can(["desarrollador"], "rollout:approve")).toBe(false);
  });

  it("el auditor es solo lectura", () => {
    const writes = permissionMatrix().filter((r) => r.auditor && /write|approve|scan|create|drill|abort/.test(r.permission));
    expect(writes.map((r) => r.permission)).toEqual(["export:create"]);
  });

  it("las acciones de cuatro ojos solo las tiene el aprobador", () => {
    for (const action of FOUR_EYES_ACTIONS) {
      const holders = ROLES.filter((r) => can([r], action));
      expect(holders).toEqual(["aprobador"]);
    }
  });

  it("ignora roles desconocidos", () => {
    expect(can(["superusuario"], "catalog:read")).toBe(false);
  });
});

describe("severidad determinista", () => {
  it("clasifica S1 sin alternativa", () => {
    expect(
      classifySeverity({
        esConsultaOCambio: false,
        servicioProductivoCaido: true,
        existeAlternativa: false,
        degradacionOSeguridad: true,
        soloNoProductivoOMenor: false,
      }).severity,
    ).toBe("S1");
  });

  it("clasifica S4 para consultas", () => {
    expect(
      classifySeverity({
        esConsultaOCambio: true,
        servicioProductivoCaido: false,
        existeAlternativa: false,
        degradacionOSeguridad: false,
        soloNoProductivoOMenor: false,
      }).severity,
    ).toBe("S4");
  });
});

describe("RUT sintéticos", () => {
  it("calcula el dígito verificador", () => {
    expect(rutDv(11111111)).toBe("1");
    expect(rutDv(76086428)).toBe("5");
    expect(formatRut(12345678)).toBe("12.345.678-5");
  });

  it("genera RUT válidos y datos reproducibles", () => {
    const a = new SyntheticData(7).concessions(20);
    const b = new SyntheticData(7).concessions(20);
    expect(a).toEqual(b);
    for (const c of a) expect(isValidRut(c.rutEmpresa)).toBe(true);
    expect(new SyntheticData(1).person().email.endsWith("@ejemplo.invalid")).toBe(true);
  });
});
