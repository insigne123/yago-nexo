import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PASO_MINIMO_S, TOPE_VIDEO_S } from "../lib/ritmo.js";
import { agendaDe, backendDeUrl, codigoHttp, definicion, duracionEstimada, lineaEnsayo, lineaShell, n, nombreBackend, revisarGuion, seg, type PasoGuion } from "./ayudas-d.js";
import { bt005, PASOS_BT005 } from "./bt005-gateway.js";
import { d01, PASOS_D01 } from "./d01-descubrimiento.js";
import { d02, PASOS_D02, VENTANAS_LINEA_BASE } from "./d02-anomalias.js";
import { d03, PASOS_D03 } from "./d03-contratos.js";
import { d04, PASOS_D04 } from "./d04-despliegues.js";
import { d05, PASOS_D05, PASOS_D05_AGENTES } from "./d05-continuidad.js";
import { ContinuidadSim, hallazgosEnsayo, pdfMinimo, sujetoToken } from "./d0x-ensayo.js";
import { buscarProhibidos } from "../lib/vigilancia.js";

const GUIONES = [
  { demo: d01, pasos: PASOS_D01 },
  { demo: d02, pasos: PASOS_D02 },
  { demo: d03, pasos: PASOS_D03 },
  { demo: d04, pasos: PASOS_D04 },
  { demo: d05, pasos: PASOS_D05 },
  { demo: bt005, pasos: PASOS_BT005 },
];

describe("guiones D-01..D-05 y BT-005: narración y duración (V03, V11)", () => {
  for (const { demo, pasos } of GUIONES) {
    it(`${demo.id}: cumple las reglas del video (≥ 7 s por paso, ≤ 240 s, textos del panel)`, () => {
      expect(revisarGuion(pasos, demo.agenda)).toEqual([]);
      expect(demo.pasos).toBe(pasos.length);
      expect(demo.agenda).toEqual(agendaDe(pasos));
      const total = duracionEstimada(pasos);
      expect(total).toBeLessThanOrEqual(TOPE_VIDEO_S);
      // Margen frente al tope: lo medido en el laboratorio puede pasar lo estimado.
      expect(total).toBeLessThanOrEqual(TOPE_VIDEO_S - 25);
    });
  }

  it("los textos no nombran a la institución compradora ni a clientes (repositorio neutro)", () => {
    const todo = JSON.stringify(GUIONES.map((g) => [g.demo.nombre, g.demo.afirmacion, g.pasos]));
    // La institución compradora y el proceso solo existen como huellas SHA-256 (vigilancia.ts): no se escriben aquí.
    expect(buscarProhibidos(todo)).toEqual([]);
    expect(todo).not.toMatch(/licitaci|mercado ?p[uú]blico/i);
  });

  it("D-04 tiene 5 pasos reales y nombra los backends por su contenedor", () => {
    expect(PASOS_D04).toHaveLength(5);
    const texto = JSON.stringify(PASOS_D04);
    expect(texto).toContain("concesiones-v1");
    expect(texto).toContain("concesiones-v2");
    expect(texto).not.toMatch(/\b1\.[01]\.0\b/);
    expect(texto).toMatch(/25 %/);
  });

  it("D-05 se cuenta en 3 actos, mide el RTO desde la falla y el retorno lo aprueban dos personas", () => {
    expect(PASOS_D05.filter((p) => /^Acto \d/.test(p.titulo)).map((p) => p.titulo.slice(0, 6))).toEqual(["Acto 1", "Acto 2", "Acto 3"]);
    expect(PASOS_D05[3]!.titulo).toMatch(/RTO medido desde la falla/);
    expect(PASOS_D05[1]!.comprueba).toContain("1 de 3 votos «primario caído»");
    // Variante de respaldo: su narración cumple las mismas reglas y declara las mismas verificaciones.
    expect(revisarGuion(PASOS_D05_AGENTES, PASOS_D05_AGENTES.map((p) => p.titulo))).toEqual([]);
    expect(PASOS_D05_AGENTES.map((p) => p.comprueba)).toEqual(PASOS_D05.map((p) => p.comprueba));
    expect(PASOS_D05_AGENTES[1]!.quePasa).toMatch(/cae la base del CPD/);
    expect(PASOS_D05.at(-1)!.titulo).toMatch(/lo pide una persona y lo aprueba otra/);
  });

  it("D-02 tiene 4 partes y declara la línea base de 61 ventanas de 30 s para A y B", () => {
    expect(PASOS_D02.map((p) => p.titulo.slice(0, 7))).toEqual(["Parte 1", "Parte 2", "Parte 3", "Parte 4"]);
    expect(VENTANAS_LINEA_BASE).toBe(61);
    expect(d02.afirmacion).toMatch(/61 ventanas de 30 s/);
    expect(PASOS_D02[0]!.comprueba!.join(" ")).toMatch(/consumidor A.*consumidor B/);
  });

  it("definicion() entrega a estudio.paso() la narración sin la estimación", () => {
    const p: PasoGuion = { titulo: "t", quePasa: "q", porQueImporta: "p", comprueba: ["c"], estimadoS: 9 };
    expect(definicion(p)).toEqual({ titulo: "t", quePasa: "q", porQueImporta: "p", comprueba: ["c"] });
  });
});

describe("revisarGuion y duracionEstimada", () => {
  const base: PasoGuion = { titulo: "Paso", quePasa: "Qué pasa.", porQueImporta: "Por qué.", comprueba: ["algo"], estimadoS: 10 };

  it("suma portada, pasos (con la lectura de la última verificación) y cierre", () => {
    const una = duracionEstimada([base]);
    const dos = duracionEstimada([base, base]);
    expect(dos - una).toBeCloseTo(12.5, 5);
    expect(duracionEstimada([{ ...base, estimadoS: 2, comprueba: [] }]) - duracionEstimada([])).toBe(PASO_MINIMO_S);
  });

  it("detecta pasos cortos, textos vacíos o largos, jerga y videos de más de 240 s", () => {
    expect(revisarGuion([{ ...base, estimadoS: 5 }])).toEqual([expect.stringMatching(/menos de 7 s/)]);
    expect(revisarGuion([{ ...base, quePasa: " " }])[0]).toMatch(/quePasa vacío/);
    expect(revisarGuion([{ ...base, titulo: "x".repeat(71) }])[0]).toMatch(/titulo de 71/);
    expect(revisarGuion([{ ...base, quePasa: "Se hace el failover." }])[0]).toMatch(/jerga/);
    expect(revisarGuion(Array.from({ length: 12 }, () => ({ ...base, estimadoS: 20 }))).at(-1)).toMatch(/tope de 240 s/);
    expect(revisarGuion([base], ["otro título"])).toEqual(["la agenda no coincide con los títulos de los pasos"]);
  });
});

describe("comandos reales y formato", () => {
  it("lineaShell pone comillas solo donde hace falta", () => {
    expect(lineaShell(["api", "deploy", "/tmp/x/tarifas", "-s", "prod", "-m", "Gobierno de la API"])).toBe('api deploy /tmp/x/tarifas -s prod -m "Gobierno de la API"');
    expect(lineaShell(['di "hola" $HOME'])).toBe('"di \\"hola\\" \\$HOME"');
  });

  it("codigoHttp lee el código que curl escribe al final", () => {
    expect(codigoHttp(['{"ok":true}', "HTTP 200"])).toBe(200);
    expect(codigoHttp(["HTTP 401", "", "HTTP 403 "])).toBe(403);
    expect(codigoHttp(["sin código"])).toBeUndefined();
  });

  it("en ensayo, las URL del laboratorio de una línea van al servidor de ensayo (lo demás no cambia)", () => {
    const base = "http://localhost:5174";
    expect(lineaEnsayo("curl -sk https://apim:8243/tarifas/1.0.0/tarifas   # sin token", base)).toBe(`curl -sk ${base}/gateway/tarifas/1.0.0/tarifas   # sin token`);
    expect(lineaEnsayo("curl -s 'http://localhost:9200/nexo-apim-metrics-*/_search' -d @q.json", base)).toBe(`curl -s '${base}/d0x/opensearch/nexo-apim-metrics-*/_search' -d @q.json`);
    expect(lineaEnsayo("seq 60 | xargs echo", base)).toBe("seq 60 | xargs echo");
    expect(lineaEnsayo("curl https://apim:8243/x", undefined)).toBe("curl https://apim:8243/x");
  });

  it("los backends se nombran por su contenedor, no por su número de versión", () => {
    expect(nombreBackend("1.0.0")).toBe("concesiones-v1");
    expect(nombreBackend("1.1.0")).toBe("concesiones-v2");
    expect(nombreBackend("9.9.9")).toBe("backend 9.9.9");
    expect(backendDeUrl("http://concesiones-v2:7001")).toBe("concesiones-v2");
    expect(backendDeUrl(undefined)).toBe("—");
  });

  it("formato chileno de cifras y segundos", () => {
    expect(n(12345)).toBe("12.345");
    expect(seg(7.04)).toBe("7,0 s");
    expect(seg(11.46, 0)).toBe("11 s");
  });
});

describe("ensayo de D-01..D-05 (d0x-ensayo.ts)", () => {
  it("continuidad: una partición deja 1 de 3 votos y no conmuta", () => {
    const s = new ContinuidadSim(6000);
    const t0 = 1_000_000;
    s.avanzar(t0);
    s.lab("particion");
    s.avanzar(t0 + 1000);
    s.avanzar(t0 + 8000);
    s.avanzar(t0 + 30_000);
    expect(s.agentes.filter((a) => a.voto === "primario_caido").map((a) => a.id)).toEqual(["gcp"]);
    expect(s.activo).toBe("cpd");
    expect(s.lab("gcp-en-espera")).toBe("t");
  });

  it("continuidad: cae el CPD, se forma la mayoría y conmuta solo; el retorno exige otra persona", () => {
    const s = new ContinuidadSim(0);
    s.lab("cpd-escribe:m1");
    s.lab("cpd-stop");
    const t = Date.now();
    s.avanzar(t); // los agentes notan la caída
    s.avanzar(t + 100); // cambian su voto: 3 de 3 «primario caído»
    expect(s.activo).toBe("cpd");
    s.avanzar(t + 2000); // el agente de Google Cloud termina de promover y reapuntar el DNS
    expect(s.activo).toBe("gcp");
    expect(s.lab("dns")).toContain("10.80.0.2");
    expect(s.lab("gcp-tiene:m1")).toBe("1");
    expect(s.eventos[0]).toMatchObject({ kind: "conmutacion", trigger: "automatico", status: "completado" });
    s.lab("cpd-start");
    const [st, sol] = s.solicitar("carla.operacion", "CPD restablecido");
    expect(st).toBe(201);
    const id = (sol as { id: string }).id;
    expect(s.aprobar(id, "carla.operacion")[0]).toBe(403);
    expect(s.aprobar(id, "luis.aprobador")[0]).toBe(202);
    s.avanzar(t + 9000);
    expect(s.activo).toBe("cpd");
    expect(s.eventos[0]).toMatchObject({ kind: "retorno", requestedBy: "carla.operacion", approvedBy: "luis.aprobador", status: "completado" });
  });

  it("descubrimiento: hallazgos ordenados por puntaje con las rutas que verifica check-d01", () => {
    const h = hallazgosEnsayo();
    expect(h.every((f, i) => i === 0 || Number(h[i - 1]!.exposureScore) >= Number(f.exposureScore))).toBe(true);
    expect(h.map((f) => f.path)).toEqual(expect.arrayContaining(["/interno/reportes/titulares", "/fiscalizacion", "/espectro/asignaciones"]));
  });

  it("PDF mínimo válido y sujeto del token de ensayo", () => {
    const pdf = pdfMinimo(["Reporte (ENSAYO)", "95 nginx-legacy/interno"]);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toMatch(/startxref\n\d+\n%%EOF/);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(sujetoToken(`Bearer ${b64({ alg: "none" })}.${b64({ preferred_username: "luis.aprobador" })}.x`)).toBe("luis.aprobador");
    expect(sujetoToken(undefined)).toBeUndefined();
  });
});

describe("veracidad de la terminal (V12)", () => {
  const ARCHIVOS = ["d01-descubrimiento.ts", "d02-anomalias.ts", "d03-contratos.ts", "d04-despliegues.ts", "d05-continuidad.ts", "bt005-gateway.ts"];
  // Los 13 guiones: una línea «$ …» es siempre un comando que se ejecuta (las llamadas REST se rotulan «→ …»).
  const TODOS = [...ARCHIVOS, "d06-graphql-asyncapi.ts", "d07-sdk.ts", "d08-autoservicio.ts", "bt008-integracion.ts", "bt018-catalogo.ts", "bt021-consumo.ts", "bt049-exportacion.ts"];
  for (const f of TODOS) {
    it(`${f}: no escribe a mano líneas «$ …» en la terminal`, () => {
      const fuente = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(fuente).not.toMatch(/c\.log\(\s*[`"']\$ /);
    });
  }

  for (const f of ARCHIVOS) {
    it(`${f}: ninguna línea «$ …» se escribe a mano (solo comando(), ejecutarComando() o seguir() la muestran)`, () => {
      const fuente = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(fuente).not.toMatch(/c\.log\(\s*[`"']\$ /);
      // Sin clics, escritura ni selección instantáneos de Playwright sobre la pantalla grabada.
      expect(fuente).not.toMatch(/c\.app\.(getByTestId|locator|getByRole|getByText)\([^)]*\)\.(click|fill|selectOption)\(/);
      expect(fuente).not.toMatch(/c\.app\.mouse\.(wheel|click)\(/);
      // Toda la narración pasa por estudio.paso (nada de la API anterior c.paso(texto)).
      expect(fuente).not.toMatch(/\bc\.paso\(/);
    });
  }

  for (const { demo, pasos } of GUIONES) {
    it(`${demo.id}: cada «Se comprueba» declarado se mide en vivo con el mismo texto, y nada se mide sin declararse`, () => {
      const f = ARCHIVOS.find((a) => a.startsWith(demo.id.toLowerCase().replace("-", "").replace("bt", "bt")))!;
      const fuente = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      const medidas = [...fuente.matchAll(/e\.(?:comprueba|exige)\(\s*"([^"]+)"/g)].map((m) => m[1]!);
      const declaradas = pasos.flatMap((p) => p.comprueba ?? []);
      expect([...medidas].sort()).toEqual([...declaradas].sort());
    });
  }

  it("en ensayo, la falla inyectable de concesiones-v2 se desvía al servidor de ensayo", () => {
    expect(lineaEnsayo("curl -s -X POST -d '{\"failRate\":1}' http://localhost:7011/_chaos   # falla", "http://localhost:5174")).toBe("curl -s -X POST -d '{\"failRate\":1}' http://localhost:5174/chaos-v2/_chaos   # falla");
  });
});
