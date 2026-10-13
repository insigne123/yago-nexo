/**
 * D-07 · Generación automática de clientes (SDK) desde el contrato OpenAPI publicado (respuesta N°91 del
 * foro: generador integrado, al menos 3 lenguajes).
 *
 * Lo que se ve, todo contra el laboratorio:
 *   1. el contrato OpenAPI publicado de la API Concesiones y sus operaciones;
 *   2. los lenguajes que el generador integrado del portal tiene habilitados (se consultan al producto:
 *      GET /api/am/devportal/v3/sdk-gen/languages), al menos 3;
 *   3. el portal genera y descarga un SDK por lenguaje; en cada uno se busca la clase de la API con todas
 *      las operaciones del contrato;
 *   4. el cliente JavaScript generado se instala como indica su README y consulta la API por el gateway.
 *
 * Duración estimada: portada 4 s + 4 pasos (≈ 14 + 12 + 40 + 45 s) + cierre 3 s ≈ 120 s (tope 240 s; la
 * instalación de npm es la parte variable).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { DefinicionPaso, Demo } from "../lib/grabador.js";
import { escaparHtml } from "../lib/grabador.js";
import { credencialesDe, tokenAplicacion, wso2 } from "../lib/lab.js";
import { prepararEnsayo } from "./bt0x-ensayo.js";
import { verPagina } from "./comun.js";

export const DURACION_ESTIMADA_S = 120;

/** Cómo reconocer, en cada lenguaje, la clase de la API dentro del SDK generado y el nombre de sus métodos. */
export const LENGUAJES: Record<
  string,
  { etiqueta: string; archivoApi: RegExp; nombre: (operationId: string) => string }
> = {
  java: { etiqueta: "JAVA", archivoApi: /ConcesionesApi\.java$/, nombre: (o) => o },
  javascript: { etiqueta: "JAVASCRIPT", archivoApi: /ConcesionesApi\.js$/, nombre: (o) => o },
  python: {
    etiqueta: "PYTHON",
    archivoApi: /concesiones_api\.py$/,
    nombre: (o) => o.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`),
  },
  csharp: {
    etiqueta: "CSHARP",
    archivoApi: /ConcesionesApi\.cs$/,
    nombre: (o) => o.charAt(0).toUpperCase() + o.slice(1),
  },
  android: { etiqueta: "ANDROID", archivoApi: /ConcesionesApi\.java$/, nombre: (o) => o },
};

export const NARRACION_D07: DefinicionPaso[] = [
  {
    titulo: "El contrato OpenAPI publicado de la API Concesiones",
    quePasa:
      "En el portal de desarrolladores se abre la consola de la API Concesiones. Su contrato OpenAPI publicado declara las operaciones que ofrece.",
    porQueImporta:
      "Los kits de desarrollo se generan desde este contrato: lo que el contrato declara es lo que el cliente podrá llamar.",
    comprueba: ["el contrato publicado tiene operaciones"],
  },
  {
    titulo: "Lenguajes del generador integrado en el portal",
    quePasa:
      "Se consulta al portal qué lenguajes tiene habilitados su generador de SDK y se abre la pestaña de descargas de la API.",
    porQueImporta:
      "Los equipos de los operadores usan distintos lenguajes; el generador viene en el producto y no requiere herramientas externas.",
    comprueba: ["el generador ofrece al menos 3 lenguajes"],
  },
  {
    titulo: "El portal genera y descarga un SDK por lenguaje",
    quePasa:
      "El portal genera al momento un SDK por lenguaje desde el contrato. En cada paquete se busca la clase de la API con sus operaciones.",
    porQueImporta:
      "Cada kit queda listo para usar y coincide con el contrato publicado, sin escribir el cliente a mano.",
    comprueba: ["SDK con todas las operaciones del contrato en al menos 3 lenguajes"],
  },
  {
    titulo: "El cliente JavaScript generado consulta la API por el gateway",
    quePasa:
      "El SDK JavaScript se instala como dice su README y un programa de pocas líneas lo usa para listar concesiones vigentes por el gateway.",
    porQueImporta:
      "El SDK no es solo código generado: funciona contra la API real, con un token OAuth emitido por Keycloak.",
    comprueba: [
      "el SDK JavaScript se instala y compila",
      "el cliente generado consulta la API por el gateway",
    ],
  },
];

export const d07: Demo = {
  id: "D-07",
  archivo: "D-07_sdk",
  nombre: "Generación automática de SDK desde el contrato OpenAPI publicado",
  afirmacion:
    "El generador integrado del portal de desarrolladores produce al momento, desde el contrato OpenAPI publicado, kits de desarrollo en los lenguajes que tiene habilitados (Java, JavaScript, Python, C# y Android en el laboratorio); cada uno trae las operaciones del contrato y el cliente JavaScript generado funciona contra el gateway.",
  pasos: NARRACION_D07.length,
  agenda: NARRACION_D07.map((p) => p.titulo),

  async preparar(c) {
    await prepararEnsayo(c);
    await c.ingresarWso2("devportal");
    return ["sesión abierta en el Dev Portal de WSO2 (usuario admin del laboratorio)"];
  },

  async ejecutar(c) {
    const e = c.estudio;
    const w = wso2();
    const api = (await w.devportal.listApis()).list.find((a) => a.name === "Concesiones");
    if (!api) throw new Error("falta la API Concesiones en el Dev Portal");

    // 1 ── Contrato publicado ────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_D07[0]!);
    await c.vista("dividido");
    await c.ir(`https://apim:9443/devportal/apis/${api.id}/api-console`);
    await c.app.waitForLoadState("networkidle").catch(() => undefined);
    await verPagina(c);
    const contrato = await w.request<{ paths?: Record<string, Record<string, { operationId?: string }>> }>({
      method: "GET",
      path: `/api/am/devportal/v3/apis/${api.id}/swagger`,
    });
    const operaciones: string[] = [];
    c.log(`→ GET /api/am/devportal/v3/apis/${api.id.slice(0, 8)}…/swagger   # contrato publicado`, "cmd");
    for (const [ruta, metodos] of Object.entries(contrato?.paths ?? {})) {
      for (const [m, op] of Object.entries(metodos)) {
        if (!op?.operationId) continue;
        operaciones.push(op.operationId);
        c.log(`  ${m.toUpperCase().padEnd(6)} ${ruta.padEnd(22)} operationId=${op.operationId}`);
      }
    }
    await e.desplazar(260);
    e.exige(
      "el contrato publicado tiene operaciones",
      operaciones.length >= 3,
      `${operaciones.length} operaciones`,
    );
    await e.esperar(2000);

    // 2 ── Lenguajes habilitados ─────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_D07[1]!);
    const habilitados = (await w.devportal.sdkLanguages()).map((l) => String(l).toLowerCase());
    c.log("→ GET /api/am/devportal/v3/sdk-gen/languages   # lenguajes del generador integrado", "cmd");
    c.log(`  ${habilitados.join(", ")}`);
    await c.ir(`https://apim:9443/devportal/apis/${api.id}/sdk`);
    const primera = habilitados.map((l) => LENGUAJES[l]?.etiqueta).find(Boolean) ?? "JAVA";
    await c.app.getByText(primera, { exact: true }).first().waitFor();
    await verPagina(c, c.app.getByText(primera, { exact: true }).first());
    await e.zoom(c.app.getByText(primera, { exact: true }).first(), { factor: 1.5, ms: 2000 });
    e.comprueba(
      "el generador ofrece al menos 3 lenguajes",
      habilitados.length >= 3,
      `${habilitados.length}: ${habilitados.join(", ")}`,
    );
    await e.esperar(1500);

    // 3 ── Generación y descarga ─────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_D07[2]!);
    const resumen: Array<{
      lenguaje: string;
      kb: number;
      archivos: number;
      clase: string;
      presentes: string[];
      ok: boolean;
    }> = [];
    const zips: Record<string, Uint8Array> = {};
    for (const id of habilitados) {
      const l = LENGUAJES[id];
      if (!l) {
        c.log(`SDK ${id}: lenguaje habilitado sin regla de revisión en este guion (no se descarga)`, "tenue");
        continue;
      }
      const tarjeta = c.app
        .locator("div")
        .filter({ has: c.app.getByText(l.etiqueta, { exact: true }) })
        .filter({ has: c.app.getByText(/download|descargar/i) })
        .last();
      const t0 = Date.now();
      const ruta = await c.descargar(tarjeta.getByText(/download|descargar/i).first(), `sdk-${id}.zip`);
      const seg = (Date.now() - t0) / 1000;
      const zip = new Uint8Array(readFileSync(ruta));
      zips[id] = zip;
      const contenido = unzipSync(zip);
      const archivos = Object.keys(contenido);
      const claseApi = archivos.find((f) => l.archivoApi.test(f));
      const fuente = claseApi ? strFromU8(contenido[claseApi]!) : "";
      const presentes = operaciones.filter((o) => fuente.includes(l.nombre(o)));
      const ok = archivos.length > 10 && !!claseApi && presentes.length === operaciones.length;
      resumen.push({
        lenguaje: id,
        kb: Math.round(zip.length / 1024),
        archivos: archivos.length,
        clase: claseApi ? basename(claseApi) : "—",
        presentes,
        ok,
      });
      c.log(
        `SDK ${id.padEnd(10)} ${String(Math.round(zip.length / 1024)).padStart(4)} KB · ${String(archivos.length).padStart(3)} archivos · ${seg.toFixed(1)} s · ${claseApi ? basename(claseApi) : "sin clase de API"}: ${presentes.length} de ${operaciones.length} operaciones`,
        ok ? "ok" : "mal",
      );
      e.indicadores({
        "SDK generados": resumen.length,
        "con todas las operaciones": resumen.filter((x) => x.ok).length,
      });
    }
    const correctos = resumen.filter((x) => x.ok).length;
    c.panel(
      `<h3>SDK generados desde el contrato publicado de Concesiones</h3><table><tr><th>Lenguaje</th><th>Tamaño</th><th>Archivos</th><th>Clase de la API</th><th>Operaciones</th></tr>${resumen
        .map(
          (x) =>
            `<tr><td>${escaparHtml(x.lenguaje)}</td><td>${x.kb} KB</td><td>${x.archivos}</td><td>${escaparHtml(x.clase)}</td><td class="${x.ok ? "ok" : "mal"}">${x.presentes.length} de ${operaciones.length}</td></tr>`,
        )
        .join("")}</table>`,
    );
    await c.vista("panel");
    e.comprueba(
      "SDK con todas las operaciones del contrato en al menos 3 lenguajes",
      correctos >= 3,
      `${correctos} de ${resumen.length} lenguajes`,
    );
    await e.esperar(3000);

    // 4 ── El cliente JavaScript generado funciona ───────────────────────────────────────────────────
    await e.paso(NARRACION_D07[3]!);
    await c.vista("terminal");
    const dir = join(c.archivos, "sdk-javascript");
    mkdirSync(dir, { recursive: true });
    let raiz = "";
    for (const [f, data] of Object.entries(zips.javascript ? unzipSync(zips.javascript) : {})) {
      if (f.endsWith("/")) continue;
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), data);
      raiz ||= f.split("/")[0]!;
    }
    const proyecto = join(dir, raiz);
    const inst = await c.ejecutarComando("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: proyecto,
      mostrar: `cd ${raiz || "javascript-client"} && npm install   # dependencias y compilación (babel) del SDK generado`,
      filtro: (l) => (/compiled|added \d+ packages|ERR/i.test(l) ? l : undefined),
      tablas: false,
    });
    e.comprueba(
      "el SDK JavaScript se instala y compila",
      !!raiz && inst.codigo === 0,
      `código ${inst.codigo}`,
    );
    const token = await tokenAplicacion(await credencialesDe("OperadorDemo"));
    const script = [
      'const Sdk = require("./dist/index.js");',
      "const cliente = Sdk.ApiClient.instance;",
      'cliente.basePath = "https://apim:8243/concesiones/1.0.0";',
      "for (const a of Object.values(cliente.authentications)) a.accessToken = process.env.TOKEN;",
      "const api = new Sdk.ConcesionesApi();",
      'api.listarConcesiones({ estado: "vigente" }, (err, lista) => {',
      '  if (err) { console.error("error", err.status); process.exit(1); }',
      '  console.log("total vigentes:", lista.total, "· primeras:", lista.items.slice(0, 3).map((x) => x.empresa).join(", "));',
      "  api.obtenerConcesion(lista.items[0].id, (e2, una) => {",
      '    if (e2) { console.error("error", e2.status); process.exit(1); }',
      '    console.log("detalle:", una.id, una.servicio, una.region, una.estado);',
      "  });",
      "});",
    ].join("\n");
    if (raiz) writeFileSync(join(proyecto, "usar_sdk.js"), `${script}\n`);
    c.log("usar_sdk.js (usa el SDK recién generado; el laboratorio tiene certificado autofirmado):", "tenue");
    for (const l of script.split("\n")) c.log(`  ${l}`, "tenue", false);
    const r = await c.ejecutarComando("node", ["--no-warnings", "usar_sdk.js"], {
      cwd: proyecto,
      env: { TOKEN: token, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      mostrar: "TOKEN=… node usar_sdk.js",
      tablas: false,
    });
    const salida = r.salida.join("\n");
    const total = /total vigentes: (\d+)/.exec(salida);
    e.comprueba(
      "el cliente generado consulta la API por el gateway",
      r.codigo === 0 && !!total,
      total?.[0] ?? `código ${r.codigo}`,
    );
    await e.esperar(2500);

    return {
      medido: `${correctos} SDK generados al momento desde el contrato publicado (${resumen.map((x) => x.lenguaje).join(", ")}), con sus ${operaciones.length} operaciones; el cliente JavaScript generado consultó la API por el gateway`,
      datos: {
        habilitados,
        lenguajes: correctos,
        operaciones,
        sdk: resumen.map(({ lenguaje, kb, archivos, ok }) => ({ lenguaje, kb, archivos, ok })),
      },
    };
  },
};
