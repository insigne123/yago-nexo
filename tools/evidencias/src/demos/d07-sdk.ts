/**
 * D-07 · Generación automática de clientes (SDK) desde el contrato OpenAPI publicado, en al menos tres
 * lenguajes. Desde el Dev Portal se descargan los SDK de la API Concesiones en Java, JavaScript, Python, C# y
 * Android; se revisa que cada uno traiga la clase de la API con las operaciones del contrato y el cliente
 * JavaScript generado se instala y se usa para llamar a la API a través del gateway.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { Demo } from "../lib/grabador.js";
import { credencialesDe, tokenAplicacion, wso2 } from "../lib/lab.js";

const LENGUAJES = [
  { id: "java", etiqueta: "JAVA", archivoApi: /ConcesionesApi\.java$/ },
  { id: "javascript", etiqueta: "JAVASCRIPT", archivoApi: /ConcesionesApi\.js$/ },
  { id: "python", etiqueta: "PYTHON", archivoApi: /concesiones_api\.py$/ },
  { id: "csharp", etiqueta: "CSHARP", archivoApi: /ConcesionesApi\.cs$/ },
  { id: "android", etiqueta: "ANDROID", archivoApi: /ConcesionesApi\.java$/ },
];

const aSnake = (s: string) => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
const aPascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const d07: Demo = {
  id: "D-07",
  archivo: "D-07_sdk",
  nombre: "Generación automática de SDK desde el contrato OpenAPI publicado",
  afirmacion:
    "El portal de desarrolladores genera al momento, desde el contrato OpenAPI publicado, kits de desarrollo en Java, JavaScript, Python, C# y Android; cada uno trae las operaciones del contrato y el cliente generado funciona contra el gateway.",
  pasos: 4,

  async preparar(c) {
    await c.ingresarWso2("devportal");
    return ["sesión abierta en el Dev Portal de WSO2 (usuario admin del laboratorio)"];
  },

  async ejecutar(c) {
    const w = wso2();
    const api = (await w.devportal.listApis()).list.find((a) => a.name === "Concesiones");
    if (!api) throw new Error("falta la API Concesiones");

    c.paso("Contrato OpenAPI publicado de la API Concesiones");
    await c.vista("app");
    await c.ir(`https://apim:9443/devportal/apis/${api.id}/api-console`);
    await c.esperar(5000);
    await c.vista("dividido");
    const contrato = await w.request<{ paths?: Record<string, Record<string, { operationId?: string; summary?: string }>> }>({ method: "GET", path: `/api/am/devportal/v3/apis/${api.id}/swagger` });
    const operaciones: string[] = [];
    c.log(`$ GET /api/am/devportal/v3/apis/${api.id.slice(0, 8)}…/swagger`, "cmd");
    for (const [ruta, metodos] of Object.entries(contrato?.paths ?? {})) {
      for (const [m, op] of Object.entries(metodos)) {
        if (!op.operationId) continue;
        operaciones.push(op.operationId);
        c.log(`  ${m.toUpperCase().padEnd(6)} ${ruta.padEnd(20)} operationId=${op.operationId}`);
      }
    }
    c.exigir("contrato publicado con operaciones", operaciones.length >= 3, `${operaciones.length} operaciones`);

    c.paso("El Dev Portal genera los SDK al momento: Java, JavaScript, Python, C# y Android");
    await c.ir(`https://apim:9443/devportal/apis/${api.id}/sdk`);
    await c.app.getByText("JAVA", { exact: true }).waitFor();
    await c.esperar(1500);
    let correctos = 0;
    const zips: Record<string, Uint8Array> = {};
    for (const l of LENGUAJES) {
      const tarjeta = c.app.locator("div").filter({ has: c.app.getByText(l.etiqueta, { exact: true }) }).filter({ has: c.app.getByText(/download/i) }).last();
      const t0 = Date.now();
      const ruta = await c.descargar(tarjeta.getByText(/download/i).first(), `sdk-${l.id}.zip`);
      const seg = (Date.now() - t0) / 1000;
      const zip = new Uint8Array(readFileSync(ruta));
      zips[l.id] = zip;
      const archivos = Object.keys(unzipSync(zip));
      const claseApi = archivos.find((f) => l.archivoApi.test(f));
      const fuente = claseApi ? strFromU8(unzipSync(zip)[claseApi]!) : "";
      const nombres = operaciones.map((o) => (l.id === "python" ? aSnake(o) : l.id === "csharp" ? aPascal(o) : o));
      const presentes = nombres.filter((n) => fuente.includes(n));
      const ok = archivos.length > 10 && !!claseApi && presentes.length === nombres.length;
      if (ok) correctos++;
      c.log(
        `SDK ${l.id.padEnd(10)} ${(zip.length / 1024).toFixed(0).padStart(4)} KB · ${String(archivos.length).padStart(3)} archivos · ${seg.toFixed(1)} s · ${claseApi ? basename(claseApi) : "sin clase de API"}: ${presentes.join(", ")}`,
        ok ? "ok" : "mal",
      );
    }
    c.verificar("SDK generados con todas las operaciones del contrato", correctos >= 3, `${correctos} de ${LENGUAJES.length} lenguajes`);
    await c.esperar(1500);

    c.paso("El cliente JavaScript generado se instala como indica su README y consulta la API por el gateway");
    const dir = join(c.archivos, "sdk-javascript");
    mkdirSync(dir, { recursive: true });
    let raiz = "";
    for (const [f, data] of Object.entries(unzipSync(zips.javascript!))) {
      if (f.endsWith("/")) continue;
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), data);
      raiz = f.split("/")[0]!;
    }
    const proyecto = join(dir, raiz);
    const inst = await c.ejecutarComando("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: proyecto,
      mostrar: `cd ${raiz} && npm install   # dependencias y compilación (babel) del SDK generado`,
      filtro: (l) => (/compiled|added \d+ packages|ERR/i.test(l) ? l : undefined),
      tablas: false,
    });
    c.exigir("SDK JavaScript instalado y compilado", inst.codigo === 0, `código ${inst.codigo}`);
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
    writeFileSync(join(proyecto, "usar_sdk.js"), `${script}\n`);
    c.log("usar_sdk.js (usa el SDK recién generado; el laboratorio tiene certificado autofirmado):", "tenue");
    for (const l of script.split("\n")) c.log(`  ${l}`, "tenue", false);
    const r = await c.ejecutarComando("node", ["--no-warnings", "usar_sdk.js"], { cwd: proyecto, env: { TOKEN: token, NODE_TLS_REJECT_UNAUTHORIZED: "0" }, mostrar: "TOKEN=… node usar_sdk.js", tablas: false });
    const salida = r.salida.join("\n");
    c.verificar("el cliente JavaScript generado consulta la API por el gateway", r.codigo === 0 && /total vigentes: \d+/.test(salida), /total vigentes: (\d+)/.exec(salida)?.[0] ?? `código ${r.codigo}`);

    c.paso("Resumen: un SDK por lenguaje, generado desde el contrato publicado");
    c.panel(
      `<h3>SDK generados desde el contrato publicado</h3><table><tr><th>Lenguaje</th><th>Tamaño</th><th>Operaciones</th></tr>${LENGUAJES.map(
        (l) => `<tr><td>${l.id}</td><td>${((zips[l.id]?.length ?? 0) / 1024).toFixed(0)} KB</td><td class="ok">${operaciones.join(", ")}</td></tr>`,
      ).join("")}</table>`,
    );
    await c.vista("panel");
    await c.esperar(5000);

    return {
      medido: `${correctos} SDK generados desde el contrato publicado (Java, JavaScript, Python, C# y Android), con sus ${operaciones.length} operaciones; el cliente JavaScript generado consultó la API por el gateway`,
      datos: { lenguajes: correctos, operaciones },
    };
  },
};
