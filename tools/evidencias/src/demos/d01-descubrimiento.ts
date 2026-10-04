/**
 * D-01 · Descubrimiento automático de APIs no gobernadas en el perímetro, con reporte de exposición.
 * La operadora lanza el escaneo desde la Consola; el motor revisa el APISIX y el NGINX «actuales» y los
 * servicios de la red autorizada, compara con el catálogo de WSO2 y puntúa la exposición. Cierra con el
 * reporte (CSV y PDF) y con la verificación automática check-d01.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Demo } from "../lib/grabador.js";
import { consola, contenedor, docker, sqlConsola, tokenPersona } from "../lib/lab.js";
import { ejecutar, esperarHasta, scriptLab, verificacionLab } from "./comun.js";

type Scan = { id: string; status: string; totals?: { endpoints?: number; gobernados?: number; noGobernados?: number; riesgoAlto?: number } };
type Finding = { id: string; source: string; host: string; port?: number; path: string; specFound: boolean; authDetected: string; personalDataSuspected: boolean; matchedApiId?: string; exposureScore: number; reasons: string[]; status: string };

const OBJETIVOS = ["ocultas:7001", "concesiones-v1:7001", "registro-soap:7001", "graphql-concesiones:7001"];

export const d01: Demo = {
  id: "D-01",
  archivo: "D-01_descubrimiento",
  nombre: "Descubrimiento automático de APIs no gobernadas",
  afirmacion:
    "El motor de descubrimiento recorre el perímetro (gateway APISIX y NGINX heredados, y servicios de la red autorizada), detecta las APIs que no están en el catálogo gobernado de WSO2, calcula su exposición y entrega el reporte en CSV y PDF.",
  pasos: 5,
  usuarioInicial: "carla.operacion",

  async preparar() {
    await scriptLab("legacy");
    sqlConsola("DELETE FROM nexo.discovery_finding; DELETE FROM nexo.discovery_scan;");
    return [
      "inventario de descubrimiento vaciado (hallazgos y escaneos anteriores) para partir de cero",
      "APISIX «actual» con la ruta /fiscalizacion y 15 llamadas de uso real por el NGINX heredado",
    ];
  },

  async ejecutar(c) {
    const operadora = await tokenPersona("carla.operacion");

    c.paso("El perímetro que revisa el motor: APISIX, NGINX heredado y la red autorizada");
    await c.ir("/descubrimiento");
    await c.app.getByTestId("btn-new-scan").waitFor();
    c.log("Fuentes configuradas en el motor de descubrimiento:", "tenue");
    const env = docker("exec", contenedor("motores"), "printenv")
      .split("\n")
      .filter((l) => l.startsWith("NEXO_DISCOVERY_") && !/KEY|SECRET|PASSWORD/i.test(l));
    for (const l of env) c.log(`  ${l}`);
    const inicial = (await consola<Finding[]>(operadora, "GET", "/discovery/findings")).data;
    c.verificar("inventario vacío antes del escaneo", inicial.length === 0, `${inicial.length} hallazgos`);
    await c.esperar(2500);

    c.paso("La operadora inicia un escaneo desde la Consola");
    await c.clic(c.app.getByTestId("btn-new-scan"));
    await c.app.getByTestId("scan-form").waitFor();
    await c.esperar(600);
    const red = c.app.getByTestId("scan-source-red");
    if (!(await red.isChecked())) await c.clic(red);
    await c.escribir(c.app.getByTestId("scan-targets"), OBJETIVOS.join("\n"), 20);
    await c.esperar(800);
    const logs = c.seguir("docker", ["logs", "-f", "--since", "1s", contenedor("motores")], {
      mostrar: "docker logs -f motores",
      filtro: (l) => {
        if (!/escaneo|descubrimiento/i.test(l)) return undefined;
        try {
          const j = JSON.parse(l) as { msg?: string; mensaje?: string };
          return `motores: ${j.msg ?? j.mensaje ?? l}`.slice(0, 160);
        } catch {
          return `motores: ${l}`.slice(0, 160);
        }
      },
    });
    const t0 = Date.now();
    await c.clic(c.app.getByTestId("btn-start-scan"));
    const fin = await esperarHasta(
      async () => (await consola<Scan[]>(operadora, "GET", "/discovery/scans")).data[0],
      (s) => !!s && s.status !== "en_curso",
      120,
      1000,
    );
    const seg = Math.round((Date.now() - t0) / 10) / 100;
    logs.detener();
    const scan = fin?.valor;
    c.exigir("escaneo terminado", scan?.status === "terminado", `${scan?.status ?? "sin respuesta"} en ${seg.toFixed(1)} s`);

    c.paso("Hallazgos comparados con el catálogo y ordenados por exposición");
    await c.app.getByTestId("table-findings").locator("tbody tr").first().waitFor({ timeout: 30_000 });
    await c.vista("app");
    await c.esperar(1500);
    await c.app.mouse.move(700, 400);
    await c.app.mouse.wheel(0, 420);
    await c.esperar(4000);
    await c.app.mouse.wheel(0, 700);
    await c.esperar(3500);
    await c.vista("dividido");
    const hallazgos = (await consola<Finding[]>(operadora, "GET", "/discovery/findings")).data;
    for (const f of hallazgos.slice(0, 9)) {
      c.log(
        `${String(f.exposureScore).padStart(3)} · ${f.host}${f.port ? `:${f.port}` : ""}${f.path} · ${f.source} · auth ${f.authDetected}${f.personalDataSuspected ? " · datos personales" : ""}${f.matchedApiId ? " · ligado a API gobernada" : " · NO gobernada"}`,
        f.exposureScore >= 70 ? "aviso" : undefined,
      );
    }
    const nginx = hallazgos.find((f) => f.source === "nginx" && f.path === "/interno/reportes/titulares");
    c.verificar("NGINX: reporte con datos personales sin autenticación", !!nginx && nginx.authDetected === "ninguna" && nginx.personalDataSuspected && nginx.exposureScore >= 90, nginx ? `puntaje ${nginx.exposureScore}` : "no encontrado");
    const apisix = hallazgos.find((f) => f.source === "apisix" && f.path === "/fiscalizacion");
    c.verificar("APISIX: ruta con key-auth fuera del catálogo", !!apisix && apisix.authDetected.startsWith("requerida") && !apisix.matchedApiId, apisix ? apisix.authDetected : "no encontrada");
    const directa = hallazgos.find((f) => f.source === "red" && f.host === "ocultas" && f.path === "/espectro/asignaciones");
    c.verificar("red: servicio directo con contrato OpenAPI publicado", !!directa && directa.specFound && directa.personalDataSuspected, directa ? `puntaje ${directa.exposureScore}` : "no encontrado");
    const bypass = hallazgos.find((f) => f.host === "concesiones-v1" && f.reasons.some((r) => r.includes("sin pasar por el gateway")));
    c.verificar("backend de una API gobernada accesible sin el gateway", !!bypass, bypass ? `${bypass.host}:${bypass.port}${bypass.path}` : "no detectado");
    const ordenados = hallazgos.every((f, i) => i === 0 || hallazgos[i - 1]!.exposureScore >= f.exposureScore);
    c.verificar("ordenados por puntaje de exposición", ordenados);

    c.paso("Reporte de exposición: CSV desde la Consola y PDF");
    const csvRuta = await c.descargar(c.app.getByTestId("btn-download-discovery-report"), "reporte-exposicion.csv");
    const csv = readFileSync(csvRuta, "utf8").trim().split("\n");
    c.log(`CSV descargado: ${csv.length - 1} filas`, "tenue");
    for (const l of csv.slice(0, 4)) c.log(`  ${l.slice(0, 150)}`);
    c.verificar("reporte CSV con todos los hallazgos", csv.length - 1 === hallazgos.length, `${csv.length - 1} filas`);
    const res = await fetch(`${process.env.NEXO_CONSOLE_URL ?? "http://localhost:8090/api/v1"}/discovery/report?format=pdf`, { headers: { authorization: `Bearer ${operadora}` } });
    const bytes = Buffer.from(await res.arrayBuffer());
    const pdfRuta = join(c.archivos, "reporte-exposicion.pdf");
    writeFileSync(pdfRuta, bytes);
    c.log(`$ GET /api/v1/discovery/report?format=pdf → ${res.status} ${res.headers.get("content-type")} · ${bytes.length} bytes`, "cmd");
    c.verificar("reporte PDF generado", res.status === 200 && bytes.subarray(0, 5).toString() === "%PDF-", `${Math.round(bytes.length / 1024)} KB`);
    // Parte superior de la primera página, a tamaño legible.
    await ejecutar("pdftoppm", ["-png", "-r", "120", "-f", "1", "-l", "1", "-x", "60", "-y", "40", "-W", "900", "-H", "640", "-singlefile", pdfRuta, join(c.archivos, "reporte-p1")]);
    c.imagen(join(c.archivos, "reporte-p1.png"), "Reporte de exposición en PDF generado por la Consola (página 1, parte superior)");
    await c.vista("panel-completo");
    await c.esperar(7000);

    c.paso("Verificación automática del escenario completo (check-d01: escanea dos veces, clasifica y audita)");
    await c.vista("terminal");
    const v = await verificacionLab(c, "check-d01", "check:d01");
    c.verificar("check-d01: escaneo, clasificación sin duplicados y reportes", v.ok);
    await c.vista("dividido");
    await c.app.reload();
    await c.app.getByTestId("table-findings").waitFor();
    await c.esperar(3000);

    const t = scan?.totals ?? {};
    return {
      medido: `${t.endpoints ?? hallazgos.length} endpoints detectados en ${seg.toFixed(0)} s: ${t.noGobernados ?? "?"} no gobernados y ${t.riesgoAlto ?? "?"} de riesgo alto, con reporte CSV y PDF`,
      datos: { segundosEscaneo: seg, endpoints: t.endpoints, noGobernados: t.noGobernados, riesgoAlto: t.riesgoAlto, maxPuntaje: hallazgos[0]?.exposureScore },
    };
  },
};
