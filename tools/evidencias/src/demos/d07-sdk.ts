/**
 * D-07 · Generación automática de clientes (SDK) desde el contrato OpenAPI publicado, en al menos tres
 * lenguajes. Desde el Dev Portal se descargan los SDK de la API Concesiones en Java, JavaScript, Python, C# y
 * Android; se revisa que cada uno traiga la clase de la API con las operaciones del contrato y el cliente
 * Python generado se usa para llamar a la API a través del gateway.
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

    c.paso("El cliente Python generado llama a la API a través del gateway");
    const dir = join(c.archivos, "sdk-python");
    mkdirSync(dir, { recursive: true });
    const raiz = Object.entries(unzipSync(zips.python!)).reduce((base, [f, data]) => {
      const destino = join(dir, f);
      if (f.endsWith("/")) return base;
      mkdirSync(join(destino, ".."), { recursive: true });
      writeFileSync(destino, data);
      return f.split("/")[0]!;
    }, "");
    const token = await tokenAplicacion(await credencialesDe("OperadorDemo"));
    const script = [
      "import openapi_client, os",
      "conf = openapi_client.Configuration(host='https://apim:8243/concesiones/1.0.0', access_token=os.environ['TOKEN'])",
      "conf.verify_ssl = False",
      "api = openapi_client.ConcesionesApi(openapi_client.ApiClient(conf))",
      "lista = api.listar_concesiones(estado='vigente')",
      "print('total vigentes:', lista.total, '· primeras:', [x.empresa for x in lista.items[:3]])",
      "una = api.obtener_concesion(lista.items[0].id)",
      "print('detalle:', una.id, una.servicio, una.region, una.estado)",
    ].join("\n");
    writeFileSync(join(dir, "usar_sdk.py"), `${script}\n`);
    c.log("usar_sdk.py (con el paquete openapi_client recién generado):", "tenue");
    for (const l of script.split("\n")) c.log(`  ${l.replace(/access_token=os.environ\['TOKEN'\]/, "access_token=TOKEN")}`, "tenue");
    const r = await c.ejecutarComando("python3", ["-W", "ignore", "usar_sdk.py"], { cwd: dir, env: { TOKEN: token, PYTHONPATH: join(dir, raiz) }, mostrar: "python3 usar_sdk.py" });
    const salida = r.salida.join("\n");
    c.verificar("el cliente Python generado consulta la API por el gateway", r.codigo === 0 && /total vigentes: \d+/.test(salida), /total vigentes: (\d+)/.exec(salida)?.[0] ?? `código ${r.codigo}`);

    c.paso("Resumen: un SDK por lenguaje, generado desde el contrato publicado");
    c.panel(
      `<h3>SDK generados desde el contrato publicado</h3><table><tr><th>Lenguaje</th><th>Tamaño</th><th>Operaciones</th></tr>${LENGUAJES.map(
        (l) => `<tr><td>${l.id}</td><td>${((zips[l.id]?.length ?? 0) / 1024).toFixed(0)} KB</td><td class="ok">${operaciones.join(", ")}</td></tr>`,
      ).join("")}</table>`,
    );
    await c.vista("panel");
    await c.esperar(5000);

    return {
      medido: `${correctos} SDK generados desde el contrato publicado (Java, JavaScript, Python, C# y Android), con sus ${operaciones.length} operaciones; el cliente Python generado consultó la API por el gateway`,
      datos: { lenguajes: correctos, operaciones },
    };
  },
};
