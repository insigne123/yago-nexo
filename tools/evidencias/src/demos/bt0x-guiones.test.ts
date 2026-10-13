/**
 * Pruebas de los guiones D-06, D-07, D-08, BT-008, BT-018, BT-021 y BT-049: narración (V11), duración
 * estimada (V03), textos publicables (V10), RUT válidos (BT-008), platform.yaml dentro del paquete (BT-049) y
 * el ensayo de estos guiones (bt0x-ensayo.ts) por HTTP.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServidorEnsayo, tokenEnsayo } from "../lib/ensayo.js";
import type { DefinicionPaso, Demo } from "../lib/grabador.js";
import { CIERRE_S, PASO_MINIMO_S, PORTADA_S, TOPE_VIDEO_S } from "../lib/ritmo.js";
import { buscarProhibidos } from "../lib/vigilancia.js";
import * as bt008m from "./bt008-integracion.js";
import * as bt018m from "./bt018-catalogo.js";
import * as bt021m from "./bt021-consumo.js";
import * as bt049m from "./bt049-exportacion.js";
import { instalarEnsayoGuiones, reiniciarEstadoEnsayo, urlLab } from "./bt0x-ensayo.js";
import * as d06m from "./d06-graphql-asyncapi.js";
import * as d07m from "./d07-sdk.js";
import * as d08m from "./d08-autoservicio.js";

const GUIONES: Array<{ demo: Demo; narracion: DefinicionPaso[]; estimada: number }> = [
  { demo: d06m.d06, narracion: d06m.NARRACION_D06, estimada: d06m.DURACION_ESTIMADA_S },
  { demo: d07m.d07, narracion: d07m.NARRACION_D07, estimada: d07m.DURACION_ESTIMADA_S },
  { demo: d08m.d08, narracion: d08m.NARRACION_D08, estimada: d08m.DURACION_ESTIMADA_S },
  { demo: bt008m.bt008, narracion: bt008m.NARRACION_BT008, estimada: bt008m.DURACION_ESTIMADA_S },
  { demo: bt018m.bt018, narracion: bt018m.NARRACION_BT018, estimada: bt018m.DURACION_ESTIMADA_S },
  { demo: bt021m.bt021, narracion: bt021m.NARRACION_BT021, estimada: bt021m.DURACION_ESTIMADA_S },
  { demo: bt049m.bt049, narracion: bt049m.NARRACION_BT049, estimada: bt049m.DURACION_ESTIMADA_S },
];

/** Lo que cabe en el panel lateral: título hasta 3 líneas, «qué pasa» y «por qué importa» hasta 4 (V04). */
const MAX = { titulo: 70, quePasa: 140, porQueImporta: 140, comprueba: 80 };

describe.each(GUIONES)("narración de $demo.id", ({ demo, narracion, estimada }) => {
  it("la agenda, los pasos anunciados y la narración coinciden", () => {
    expect(demo.pasos).toBe(narracion.length);
    expect(demo.agenda).toEqual(narracion.map((p) => p.titulo));
    expect(new Set(demo.agenda).size).toBe(narracion.length);
  });

  it("cada paso tiene título, qué pasa, por qué importa y lo que se comprueba, y cabe en el panel", () => {
    for (const p of narracion) {
      expect(p.titulo.length, p.titulo).toBeGreaterThan(5);
      expect(p.titulo.length, p.titulo).toBeLessThanOrEqual(MAX.titulo);
      expect(p.quePasa.length, p.quePasa).toBeGreaterThan(40);
      expect(p.quePasa.length, p.quePasa).toBeLessThanOrEqual(MAX.quePasa);
      expect(p.porQueImporta.length, p.porQueImporta).toBeGreaterThan(40);
      expect(p.porQueImporta.length, p.porQueImporta).toBeLessThanOrEqual(MAX.porQueImporta);
      expect(p.quePasa).not.toBe(p.titulo);
      for (const c of p.comprueba ?? []) expect(c.length, c).toBeLessThanOrEqual(MAX.comprueba);
    }
    expect(narracion.some((p) => (p.comprueba ?? []).length > 0)).toBe(true);
  });

  it("la duración estimada respeta el mínimo de 7 s por paso y el tope de 240 s", () => {
    expect(estimada).toBeLessThanOrEqual(TOPE_VIDEO_S);
    expect(estimada).toBeGreaterThanOrEqual(PORTADA_S + CIERRE_S + PASO_MINIMO_S * narracion.length);
  });

  it("no hay textos no publicables en lo que se ve (vigilancia del motor)", () => {
    const todo = [demo.nombre, demo.afirmacion, ...narracion.flatMap((p) => [p.titulo, p.quePasa, p.porQueImporta, ...(p.comprueba ?? [])])].join("\n");
    expect(buscarProhibidos(todo)).toEqual([]);
  });
});

describe("BT-008: RUT de las solicitudes", () => {
  it("calcula el dígito verificador (módulo 11)", () => {
    expect(bt008m.digitoRut(76086428)).toBe("5");
    expect(bt008m.digitoRut(96806980)).toBe("2");
    expect(bt008m.digitoRut(76354771)).toBe("K");
    expect(bt008m.digitoRut(61002000)).toBe("3");
  });

  it("las dos solicitudes del video usan RUT válidos y el RUT anterior de la falla era inválido", () => {
    expect(bt008m.rutValido(bt008m.RUT_VALIDA)).toBe(true);
    expect(bt008m.rutValido(bt008m.RUT_FALLA)).toBe(true);
    expect(bt008m.rutValido("96.512.340-1")).toBe(false);
    expect(bt008m.rutValido("1")).toBe(false);
  });
});

describe("BT-049: configuración de la plataforma dentro del paquete", () => {
  it("encuentra platform.yaml en cualquier carpeta del paquete y no en otros archivos", () => {
    expect(bt049m.configuracionEnPaquete(["manifiesto.json", "configuracion/platform.yaml"])).toBe("configuracion/platform.yaml");
    expect(bt049m.configuracionEnPaquete(["platform.yml"])).toBe("platform.yml");
    expect(bt049m.configuracionEnPaquete(["apis/x.zip", "platform.yaml.bak", "metadatos/catalogo.json"])).toBeUndefined();
  });
});

describe("D-07: nombres de las operaciones por lenguaje", () => {
  it("Python usa snake_case y C# PascalCase", () => {
    expect(d07m.LENGUAJES.python!.nombre("listarConcesiones")).toBe("listar_concesiones");
    expect(d07m.LENGUAJES.csharp!.nombre("listarConcesiones")).toBe("ListarConcesiones");
    expect(d07m.LENGUAJES.java!.nombre("listarConcesiones")).toBe("listarConcesiones");
  });
});

describe("ensayo de estos guiones", () => {
  it("urlLab desvía solo los puertos locales del laboratorio, y solo en ensayo", () => {
    expect(urlLab("http://localhost:7001/_estadisticas", "http://localhost:5174")).toBe("http://localhost:5174/bt0x/7001/_estadisticas");
    expect(urlLab("http://localhost:15672/api/queues/%2F/solicitudes.dlq", "http://localhost:5174")).toBe("http://localhost:5174/bt0x/15672/api/queues/%2F/solicitudes.dlq");
    expect(urlLab("http://localhost:8090/api/v1", "http://localhost:5174")).toBe("http://localhost:8090/api/v1");
    expect(urlLab("http://localhost:7001/_estadisticas", undefined)).toBe("http://localhost:7001/_estadisticas");
  });

  const puerto = 5300 + Math.floor(Math.random() * 400);
  const s = new ServidorEnsayo({ puerto });
  const base = `http://127.0.0.1:${puerto}`;
  const token = (u: string) => ({ authorization: `Bearer ${tokenEnsayo(u)}` });
  const basico = (u: string) => ({ authorization: `Basic ${Buffer.from(`${u}:x`).toString("base64")}` });
  beforeAll(async () => {
    instalarEnsayoGuiones({ siempre: true });
    reiniciarEstadoEnsayo();
    await s.iniciar();
  });
  afterAll(() => s.detener());

  it("GraphQL: con token responde, sin token 401 y un campo fuera del esquema 400", async () => {
    const q = (h: Record<string, string>, query: string) =>
      fetch(`${base}/gateway/graphql/concesiones/1.0.0`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ query }) });
    const ok = await q(token("ck-operadordemo"), "{ totalPorEstado { estado total } }");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { totalPorEstado: unknown[] } }).data.totalPorEstado.length).toBeGreaterThan(0);
    expect((await q({}, "{ totalPorEstado { estado } }")).status).toBe(401);
    expect((await q(token("x"), "{ concesiones { id campoInexistente } }")).status).toBe(400);
  });

  it("solicitudes: 202 con correlación, misma clave sin duplicar, inválida 422", async () => {
    const post = (clave: string, b: unknown) =>
      fetch(`${base}/gateway/solicitudes/1.0.0/`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": clave, ...token("ck-operadordemo") }, body: JSON.stringify(b) });
    const b = { rutEmpresa: bt008m.RUT_VALIDA, servicio: "Internet", region: "Los Lagos" };
    const r1 = (await (await post("k1", b)).json()) as { correlacion: string };
    const r2 = (await (await post("k1", b)).json()) as { correlacion: string };
    expect(r1.correlacion).toMatch(/^urn:uuid:/);
    expect(r2.correlacion).toBe(r1.correlacion);
    expect((await post("k2", { rutEmpresa: "1", servicio: "X" })).status).toBe(422);
  });

  it("la cola de fallidos se lee como cantidad (solo lectura) y el destino informa sus registros", async () => {
    const cola = (await (await fetch(`${base}/bt0x/15672/api/queues/%2F/solicitudes.dlq`)).json()) as { messages: number };
    expect(cola.messages).toBe(0);
    const destino = (await (await fetch(`${base}/bt0x/7001/_estadisticas`)).json()) as { registrosCreados: number };
    expect(typeof destino.registrosCreados).toBe("number");
  });

  it("autoservicio: registro pendiente, aprobación y suscripción que habilita el gateway", async () => {
    const form = (ruta: string, datos: Record<string, string>, h: Record<string, string> = {}) =>
      fetch(`${base}/wso2${ruta}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...h }, body: new URLSearchParams(datos).toString() });
    await form("/accountrecoveryendpoint/register.do", { paso: "datos", username: "operador.prueba", password: "x" });
    const pend = (await (await fetch(`${base}/wso2/api/am/admin/v4/workflows?workflowType=AM_USER_SIGNUP`, { headers: basico("admin") })).json()) as { list: Array<{ referenceId: string; properties: { tenantAwareUserName: string } }> };
    const t = pend.list.find((x) => x.properties.tenantAwareUserName === "operador.prueba")!;
    expect(t).toBeDefined();
    const aprobar = (ref: string) => fetch(`${base}/wso2/api/am/admin/v4/workflows/update-workflow-status?workflowReferenceId=${ref}`, { method: "POST", headers: { "content-type": "application/json", ...basico("admin") }, body: JSON.stringify({ status: "APPROVED" }) });
    expect((await aprobar(t.referenceId)).status).toBe(200);
    // Aplicación, llaves y suscripción por REST, cada una con su aprobación.
    const app = (await (await fetch(`${base}/wso2/api/am/devportal/v3/applications`, { method: "POST", headers: { "content-type": "application/json", ...basico("operador.prueba") }, body: JSON.stringify({ name: "App prueba" }) })).json()) as { applicationId: string };
    await fetch(`${base}/wso2/api/am/devportal/v3/applications/${app.applicationId}/generate-keys`, { method: "POST", headers: basico("operador.prueba") });
    await fetch(`${base}/wso2/api/am/devportal/v3/subscriptions`, { method: "POST", headers: { "content-type": "application/json", ...basico("operador.prueba") }, body: JSON.stringify({ applicationId: app.applicationId, apiId: "api-concesiones", throttlingPolicy: "OperadoresEstandar" }) });
    const todas = (await (await fetch(`${base}/wso2/api/am/admin/v4/workflows`, { headers: basico("admin") })).json()) as { list: Array<{ referenceId: string; workflowType: string }> };
    const sus = todas.list.find((x) => x.workflowType === "AM_SUBSCRIPTION_CREATION")!;
    for (const w of todas.list.filter((x) => x !== sus)) await aprobar(w.referenceId);
    const llaves = (await (await fetch(`${base}/wso2/api/am/devportal/v3/applications/${app.applicationId}/oauth-keys`, { headers: basico("operador.prueba") })).json()) as { list: Array<{ consumerKey: string }> };
    const ck = llaves.list[0]!.consumerKey;
    const gw = () => fetch(`${base}/gateway/concesiones/1.0.0/concesiones?estado=vigente`, { headers: token(ck) });
    expect((await gw()).status).toBe(403);
    await aprobar(sus.referenceId);
    expect((await gw()).status).toBe(200);
  });

  it("el plan OperadoresEstandar limita a 20 llamadas por segundo (429)", async () => {
    const r = await Promise.all(Array.from({ length: 30 }, () => fetch(`${base}/gateway/concesiones/1.0.0/concesiones/CON-000002`, { headers: token("ck-fiscalizacion") })));
    expect(r.filter((x) => x.status === 429).length).toBeGreaterThan(0);
  });

  it("exportación: el paquete trae manifiesto y platform.yaml, y el lector estándar lo lee", async () => {
    const creado = (await (await fetch(`${base}/api/v1/exports`, { method: "POST", headers: token("admin.nexo") })).json()) as { downloadUrl: string };
    const zip = unzipSync(new Uint8Array(await (await fetch(`${base}${creado.downloadUrl}`)).arrayBuffer()));
    const man = JSON.parse(strFromU8(zip["manifiesto.json"]!)) as { items: Array<{ archivo: string; tipo: string }> };
    expect(man.items.map((i) => i.tipo)).toEqual(expect.arrayContaining(["api", "flujo", "metadatos"]));
    expect(bt049m.configuracionEnPaquete(Object.keys(zip))).toBe("configuracion/platform.yaml");
    let python = true;
    try {
      execFileSync("python3", ["-c", "import yaml"], { stdio: "ignore" });
    } catch {
      python = false;
    }
    if (!python) return;
    const dir = mkdtempSync(join(tmpdir(), "bt049-"));
    try {
      for (const [f, d] of Object.entries(zip)) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        writeFileSync(join(dir, f), d);
      }
      writeFileSync(join(dir, "leer.py"), bt049m.LECTOR);
      const salida = execFileSync("python3", [join(dir, "leer.py"), dir], { encoding: "utf8" }).trim().split("\n");
      expect(salida.length).toBeGreaterThanOrEqual(man.items.length);
      expect(salida.some((l) => l.startsWith("yaml configuracion/platform.yaml"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sin ensayo de estos guiones, las rutas del motor siguen respondiendo", async () => {
    const r = await fetch(`${base}/salud`);
    expect(r.status).toBe(200);
  });
});
