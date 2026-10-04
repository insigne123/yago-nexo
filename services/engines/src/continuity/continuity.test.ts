import { describe, expect, it } from "vitest";
import { aggregate, type Check } from "./health.js";
import { decideFailover, type SiteVote } from "./quorum.js";

const C = (ok: boolean, essential = true): Check => ({ name: "x", essential, ok });
const V = (id: string, role: SiteVote["role"], vote: SiteVote["vote"], ageSec = 1): SiteVote => ({ id, role, vote, ageSec });

describe("histéresis de salud", () => {
  it("vota caído solo tras varios ciclos seguidos y se recupera en uno", () => {
    let h = aggregate(undefined, [C(true)], 3);
    expect(h.vote).toBe("primario_sano");
    h = aggregate(h, [C(false)], 3);
    h = aggregate(h, [C(false)], 3);
    expect(h.vote).toBe("primario_sano"); // dos ciclos: todavía no
    h = aggregate(h, [C(false)], 3);
    expect(h.vote).toBe("primario_caido"); // tercer ciclo
    h = aggregate(h, [C(true)], 3);
    expect(h.vote).toBe("primario_sano"); // un ciclo sano basta
  });

  it("una comprobación no esencial caída no tumba el voto", () => {
    expect(aggregate(undefined, [C(true), C(false, false)], 1).vote).toBe("primario_sano");
  });
});

describe("quórum de conmutación (2 de 3)", () => {
  const backup = { maxAgeSec: 20, backupHealthy: true, backupId: "gcp" };

  it("conmuta cuando 2 de 3 ven el primario caído y el respaldo está sano", () => {
    const d = decideFailover([V("cpd", "primario", "primario_caido"), V("gcp", "respaldo", "primario_caido"), V("testigo", "testigo", "primario_caido")], backup);
    expect(d.conmutar).toBe(true);
    expect(d.votosCaido).toBe(3);
  });

  it("no conmuta con un solo voto de caído (posible partición de un agente)", () => {
    const d = decideFailover([V("cpd", "primario", "primario_sano"), V("gcp", "respaldo", "primario_caido"), V("testigo", "testigo", "primario_sano")], backup);
    expect(d.conmutar).toBe(false);
    expect(d.motivo).toMatch(/se requieren 2/);
  });

  it("no conmuta sin quórum de votos vigentes (votos viejos no cuentan)", () => {
    const d = decideFailover([V("gcp", "respaldo", "primario_caido", 1), V("cpd", "primario", "primario_caido", 99), V("testigo", "testigo", "primario_caido", 99)], backup);
    expect(d.conmutar).toBe(false);
    expect(d.motivo).toMatch(/sin quórum/);
  });

  it("no conmuta si los votos de los otros agentes expiraron y ya no están en etcd", () => {
    // Con los agentes del CPD y testigo detenidos, sus votos expiran y solo queda el del respaldo.
    const solo = [V("gcp", "respaldo", "primario_caido")];
    const d = decideFailover(solo, backup);
    expect(d.conmutar).toBe(false);
    expect(d.quorum).toBe(2);
    expect(d.motivo).toMatch(/sin quórum: solo 1 de 3/);
  });

  it("con los tres agentes de vuelta y dos votos de caído, conmuta", () => {
    const d = decideFailover([V("gcp", "respaldo", "primario_caido"), V("testigo", "testigo", "primario_caido")], backup);
    expect(d.conmutar).toBe(true);
  });

  it("no se autopromueve un respaldo degradado o aislado", () => {
    const allDown = [V("cpd", "primario", "primario_caido"), V("gcp", "respaldo", "primario_caido"), V("testigo", "testigo", "primario_caido")];
    expect(decideFailover(allDown, { ...backup, backupHealthy: false }).conmutar).toBe(false);
    const isolatedBackup = [V("cpd", "primario", "primario_caido"), V("gcp", "respaldo", "primario_caido", 99), V("testigo", "testigo", "primario_caido")];
    expect(decideFailover(isolatedBackup, backup).conmutar).toBe(false);
  });
});

describe("retorno: re-sincronización de la réplica", async () => {
  const { replicaResyncStep } = await import("./engine.js");
  it("solo se da por cumplida si la réplica volvió a estar en espera", () => {
    expect(replicaResyncStep(true)).toMatchObject({ ok: true });
    expect(replicaResyncStep(false)).toMatchObject({ ok: false, pendiente: true });
    expect(replicaResyncStep(undefined)).toMatchObject({ ok: false, pendiente: true });
  });
});
