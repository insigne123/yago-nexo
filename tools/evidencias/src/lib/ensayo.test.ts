import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { avanzarRollout, ServidorEnsayo, tokenEnsayo, type RolloutEnsayo } from "./ensayo.js";
import { reescribirUrlEnsayo, URL_LAB } from "./lab.js";

const rollout = (o: Partial<RolloutEnsayo> = {}): RolloutEnsayo => ({
  id: "ens-001",
  apiId: "api",
  apiName: "Concesiones 1.0.0",
  strategy: "canary",
  candidateEndpoint: "http://concesiones-v2:7001",
  stableEndpoint: "http://concesiones-v1:7001",
  shadowSeconds: 3,
  steps: [5, 25, 50, 100],
  stepDurationSec: 2,
  status: "en_curso",
  createdAt: "2026-10-12T00:00:00Z",
  currentWeight: 0,
  stepsDone: [],
  requestedBy: "ana.desarrollo",
  ensayo: true,
  ...o,
});

describe("despliegue simulado del servidor de ensayo (V09)", () => {
  it("canary sano: sombra y luego 5 → 25 → 50 → 100 %", () => {
    expect(avanzarRollout(rollout(), 1, 0)).toMatchObject({ status: "en_curso", currentWeight: 0 });
    expect(avanzarRollout(rollout(), 4, 0)).toMatchObject({ status: "en_curso", currentWeight: 5 });
    expect(avanzarRollout(rollout(), 6, 0)).toMatchObject({ status: "en_curso", currentWeight: 25 });
    const fin = avanzarRollout(rollout(), 12, 0);
    expect(fin.status).toBe("completado");
    expect(fin.currentWeight).toBe(100);
    expect(fin.stepsDone.map((s) => (s.kind === "sombra" ? "sombra" : s.weight))).toEqual([
      "sombra",
      5,
      25,
      50,
      100,
    ]);
  });

  it("candidata con fallas: se revierte en la fase sombra con su motivo", () => {
    const r = avanzarRollout(rollout(), 3, 0.5);
    expect(r.status).toBe("revertido");
    expect(r.currentWeight).toBe(0);
    expect(r.rollbackReason).toMatch(/50 %.*2 %/);
  });

  it("blue-green conmuta de una vez y un despliegue pendiente no avanza", () => {
    expect(avanzarRollout(rollout({ strategy: "blue_green", stepDurationSec: 5 }), 3, 0).currentWeight).toBe(
      0,
    );
    expect(avanzarRollout(rollout({ strategy: "blue_green", stepDurationSec: 5 }), 6, 0)).toMatchObject({
      status: "completado",
      currentWeight: 100,
    });
    const p = rollout({ status: "pendiente_aprobacion" });
    expect(avanzarRollout(p, 100, 0)).toBe(p);
  });

  it("el token de ensayo lleva la persona y la marca de ensayo", () => {
    const t = tokenEnsayo("luis.aprobador");
    const carga = JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()) as Record<
      string,
      unknown
    >;
    expect(carga).toMatchObject({ preferred_username: "luis.aprobador", ensayo: true });
  });
});

describe("desvío de las URL del laboratorio en ensayo", () => {
  const base = "http://localhost:5174";
  it("reescribe cada origen del laboratorio a su prefijo", () => {
    expect(reescribirUrlEnsayo("https://apim:9443/publisher/apis", base)).toBe(`${base}/wso2/publisher/apis`);
    expect(reescribirUrlEnsayo("https://apim:8243/concesiones/1.0.0/x?y=1", base)).toBe(
      `${base}/gateway/concesiones/1.0.0/x?y=1`,
    );
    expect(reescribirUrlEnsayo("http://keycloak:8080/realms/nexo/protocol/openid-connect/token", base)).toBe(
      `${base}/keycloak/realms/nexo/protocol/openid-connect/token`,
    );
    expect(reescribirUrlEnsayo("http://localhost:8090/api/v1/rollouts", base)).toBe(
      `${base}/api/v1/rollouts`,
    );
    expect(reescribirUrlEnsayo("http://localhost:7011/_chaos", base)).toBe(`${base}/chaos-v2/_chaos`);
  });

  it("no toca otras URL ni nada fuera de ensayo", () => {
    expect(reescribirUrlEnsayo("https://apim:94430/x", base)).toBe("https://apim:94430/x");
    expect(reescribirUrlEnsayo("http://localhost:5173/__estudio/", base)).toBe(
      "http://localhost:5173/__estudio/",
    );
    expect(reescribirUrlEnsayo("https://apim:9443/publisher", undefined)).toBe("https://apim:9443/publisher");
  });

  it("page.route() solo intercepta orígenes del laboratorio", () => {
    expect(URL_LAB.test("https://apim:9443/devportal/apis")).toBe(true);
    expect(URL_LAB.test("http://keycloak:8080")).toBe(true);
    expect(URL_LAB.test("http://localhost:8090/api/v1/x")).toBe(true);
    expect(URL_LAB.test("http://localhost:5173/despliegues")).toBe(false);
    expect(URL_LAB.test("https://ejemplo.org/apim:9443")).toBe(false);
  });
});

describe("servidor de ensayo por HTTP", () => {
  const s = new ServidorEnsayo({ puerto: 5191 });
  const token = async (u: string) => {
    const r = await fetch(`${s.url}/keycloak/realms/nexo/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", username: u, password: "x" }).toString(),
    });
    return ((await r.json()) as { access_token: string }).access_token;
  };
  beforeAll(() => s.iniciar());
  afterAll(() => s.detener());

  it("cuatro ojos: quien solicita no aprueba; otra persona sí", async () => {
    const dev = await token("ana.desarrollo");
    const apr = await token("luis.aprobador");
    const api = (t: string, metodo: string, ruta: string, cuerpo?: unknown) =>
      fetch(`${s.url}/api/v1${ruta}`, {
        method: metodo,
        headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
    const creado = await api(dev, "POST", "/rollouts", {
      strategy: "canary",
      shadowSeconds: 0,
      steps: [100],
      stepDurationSec: 1,
    });
    expect(creado.status).toBe(201);
    const r = (await creado.json()) as RolloutEnsayo;
    expect(r).toMatchObject({ status: "pendiente_aprobacion", requestedBy: "ana.desarrollo", ensayo: true });
    expect((await api(dev, "POST", `/rollouts/${r.id}/approve`)).status).toBe(403);
    const ok = await api(apr, "POST", `/rollouts/${r.id}/approve`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as RolloutEnsayo).approvedBy).toBe("luis.aprobador");
    expect(ok.headers.get("x-ensayo")).toBe("1");
  });

  it("los portales de WSO2 piden inicio de sesión y todas las páginas van rotuladas ENSAYO", async () => {
    const r = await fetch(`${s.url}/wso2/publisher/apis`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toMatch(/authenticationendpoint\/login\.do\?portal=publisher/);
    const login = await (await fetch(`${s.url}/wso2${r.headers.get("location")}`)).text();
    expect(login).toContain('id="username"');
    expect(login).toContain(">ENSAYO<");
    const kc = await (
      await fetch(
        `${s.url}/keycloak/realms/nexo/protocol/openid-connect/auth?redirect_uri=http://localhost:5173/auth/callback&state=s`,
      )
    ).text();
    expect(kc).toContain('id="kc-login"');
    expect(kc).toContain(">ENSAYO<");
  });
});
