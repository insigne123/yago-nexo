/**
 * D-01 · Descubrimiento automático de APIs no gobernadas en el perímetro, con reporte de exposición.
 * La operadora lanza el escaneo desde la Consola; el motor revisa el APISIX y el NGINX heredados y los
 * servicios de la red autorizada, compara con el catálogo gobernado y puntúa la exposición. Cierra con el
 * reporte (CSV y PDF) y con la verificación automática check-d01 (el mismo comando que usa el equipo).
 * Duración estimada: ≈ 130 s (ver ayudas-d.test.ts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetch } from "undici";
import type { Demo } from "../lib/grabador.js";
import { CONSOLA_API, consola, contenedor, sqlConsola, tokenPersona } from "../lib/lab.js";
import { desdeRaiz } from "../lib/entorno.js";
import { ejecutar, esperarHasta, scriptLab } from "./comun.js";
import { abrir, agendaDe, ampliar, aparece, comando, corto, desplazarSiHay, seg, type PasoGuion } from "./ayudas-d.js";
import { prepararEnsayoD } from "./d0x-ensayo.js";

type Scan = { id: string; status: string; totals?: { endpoints?: number; gobernados?: number; noGobernados?: number; riesgoAlto?: number } };
type Finding = { id: string; source: string; host: string; port?: number; path: string; specFound: boolean; authDetected: string; personalDataSuspected: boolean; matchedApiId?: string; exposureScore: number; reasons: string[]; status: string };

const OBJETIVOS = ["ocultas:7001", "concesiones-v1:7001", "registro-soap:7001", "graphql-concesiones:7001"];
const MOTORES = contenedor("motores");

export const PASOS_D01: PasoGuion[] = [
  {
    titulo: "El perímetro que revisa el motor de descubrimiento",
    quePasa: "El motor recorre el gateway APISIX y el NGINX heredados y los servicios de la red autorizada. Antes de empezar, el inventario está vacío.",
    porQueImporta: "Una API que nadie gobierna puede exponer datos sin control: primero hay que saber que existe.",
    comprueba: ["fuentes del motor configuradas", "inventario vacío antes del escaneo"],
    estimadoS: 9,
  },
  {
    titulo: "La operadora inicia un escaneo desde la Consola",
    quePasa: "Elige las fuentes, escribe las direcciones de la red autorizada y lanza el escaneo. El motor compara lo que encuentra con el catálogo gobernado.",
    porQueImporta: "Se ejecuta bajo demanda o programado, sin instalar nada en los sistemas que se revisan.",
    comprueba: ["escaneo terminado"],
    estimadoS: 26,
  },
  {
    titulo: "Hallazgos ordenados por exposición",
    quePasa: "Cada endpoint recibe un puntaje según si pide clave, si parece tener datos personales y si está en el catálogo. Los más expuestos quedan arriba.",
    porQueImporta: "Así se atiende primero lo más riesgoso, como un reporte con datos personales publicado sin clave.",
    comprueba: ["NGINX: datos personales sin autenticación", "APISIX: ruta fuera del catálogo", "servicio directo con contrato publicado", "backend accesible sin pasar por el gateway", "ordenados por puntaje de exposición"],
    estimadoS: 22,
  },
  {
    titulo: "Reporte de exposición en CSV y PDF",
    quePasa: "Desde la Consola se descarga el reporte en CSV; la misma Consola entrega el reporte en PDF, que se muestra en pantalla.",
    porQueImporta: "El reporte deja constancia de lo encontrado y sirve para planificar su incorporación al gobierno.",
    comprueba: ["CSV con todos los hallazgos", "PDF generado por la Consola"],
    estimadoS: 16,
  },
  {
    titulo: "Verificación automática del escenario (check-d01)",
    quePasa: "La verificación que usa el equipo escanea dos veces y revisa que no haya duplicados, que se respete la clasificación y que todo quede auditado.",
    porQueImporta: "Un programa independiente confirma el resultado; la demostración no depende de lo que se alcanza a ver.",
    comprueba: ["check-d01 aprobado"],
    estimadoS: 40,
  },
];

export const d01: Demo = {
  id: "D-01",
  archivo: "D-01_descubrimiento",
  nombre: "Descubrimiento automático de APIs no gobernadas",
  afirmacion:
    "El motor de descubrimiento recorre el perímetro (gateway APISIX y NGINX heredados, y servicios de la red autorizada), detecta las APIs que no están en el catálogo gobernado, calcula su exposición y entrega el reporte en CSV y PDF.",
  pasos: PASOS_D01.length,
  agenda: agendaDe(PASOS_D01),
  usuarioInicial: "carla.operacion",

  async preparar(c) {
    await prepararEnsayoD(c);
    if (!c.estudio.ensayo) await scriptLab("legacy");
    sqlConsola("DELETE FROM nexo.discovery_finding; DELETE FROM nexo.discovery_scan;");
    return [
      "inventario de descubrimiento vaciado (hallazgos y escaneos anteriores) para partir de cero",
      "APISIX con la ruta /fiscalizacion y 15 llamadas de uso real por el NGINX heredado",
    ];
  },

  async ejecutar(c) {
    const e = c.estudio;
    const operadora = await tokenPersona("carla.operacion");

    // ── 1. Perímetro ───────────────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_D01[0]!);
    await c.ir("/descubrimiento");
    await aparece(c.app.getByTestId("btn-new-scan"), 20_000);
    const fuentes = await comando(c, `docker exec ${MOTORES} sh -c 'printenv | grep ^NEXO_DISCOVERY_ | grep -v -E "KEY|SECRET|PASSWORD"'`, {
      soloLaboratorio: true,
      simulado: { codigo: 0, salida: ["NEXO_DISCOVERY_APISIX_ADMIN=http://apisix:9180", "NEXO_DISCOVERY_NGINX_CONF=/etc/nexo/descubrimiento/nginx", `NEXO_DISCOVERY_TARGETS=${OBJETIVOS.join(",")}`] },
    });
    e.comprueba("fuentes del motor configuradas", fuentes.codigo === 0 && fuentes.salida.some((l) => l.startsWith("NEXO_DISCOVERY_")), `${fuentes.salida.filter((l) => l.startsWith("NEXO_DISCOVERY_")).length} variables NEXO_DISCOVERY_*`);
    const inicial = (await consola<Finding[]>(operadora, "GET", "/discovery/findings")).data;
    e.comprueba("inventario vacío antes del escaneo", Array.isArray(inicial) && inicial.length === 0, `${inicial.length} hallazgos`);

    // ── 2. Escaneo ─────────────────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_D01[1]!);
    await e.clic(c.app.getByTestId("btn-new-scan"));
    await aparece(c.app.getByTestId("scan-form"), 10_000);
    for (const f of ["apisix", "nginx", "red"]) {
      const casilla = c.app.getByTestId(`scan-source-${f}`);
      if (await aparece(casilla, 2000)) await e.marcar(casilla, true);
    }
    await e.escribir(c.app.getByTestId("scan-targets"), OBJETIVOS.join("\n"), { ms: 55 });
    const logs = c.seguir("docker", ["logs", "-f", "--since", "1s", MOTORES], {
      mostrar: `docker logs -f --since 1s ${MOTORES}`,
      filtro: (l) => {
        if (!/escaneo|descubrimiento/i.test(l)) return undefined;
        try {
          const j = JSON.parse(l) as { msg?: string; mensaje?: string };
          return corto(`motores: ${j.msg ?? j.mensaje ?? l}`, 160);
        } catch {
          return corto(`motores: ${l}`, 160);
        }
      },
    });
    const t0 = Date.now();
    await e.clic(c.app.getByTestId("btn-start-scan"));
    const fin = await esperarHasta(async () => (await consola<Scan[]>(operadora, "GET", "/discovery/scans")).data[0], (s) => !!s && s.status !== "en_curso", 120, 1000);
    const segEscaneo = (Date.now() - t0) / 1000;
    logs.detener();
    const scan = fin?.valor;
    e.indicadores({ "endpoints encontrados": scan?.totals?.endpoints ?? "?", "no gobernados": scan?.totals?.noGobernados ?? "?", "riesgo alto": scan?.totals?.riesgoAlto ?? "?", "duración del escaneo": seg(segEscaneo) });
    e.exige("escaneo terminado", scan?.status === "terminado", `${scan?.status ?? "sin respuesta"} en ${seg(segEscaneo)}`);

    // ── 3. Hallazgos ───────────────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_D01[2]!);
    await aparece(c.app.getByTestId("table-findings").locator("tbody tr").first(), 30_000);
    const hallazgos = (await consola<Finding[]>(operadora, "GET", "/discovery/findings")).data;
    const primera = c.app.getByTestId("table-findings").locator("tbody tr").first();
    await desplazarSiHay(c, primera);
    await ampliar(c, primera, 3000, 1.5);
    for (const f of hallazgos.slice(0, 8)) {
      c.log(
        `${String(f.exposureScore).padStart(3)} · ${f.host}${f.port ? `:${f.port}` : ""}${f.path} · ${f.source} · clave ${f.authDetected}${f.personalDataSuspected ? " · datos personales" : ""}${f.matchedApiId ? " · ligado a una API gobernada" : " · NO gobernada"}`,
        f.exposureScore >= 70 ? "aviso" : undefined,
      );
    }
    const nginx = hallazgos.find((f) => f.source === "nginx" && f.path === "/interno/reportes/titulares");
    e.comprueba("NGINX: datos personales sin autenticación", !!nginx && nginx.authDetected === "ninguna" && nginx.personalDataSuspected && nginx.exposureScore >= 90, nginx ? `${nginx.path} · puntaje ${nginx.exposureScore}` : "no encontrado");
    const apisix = hallazgos.find((f) => f.source === "apisix" && f.path === "/fiscalizacion");
    e.comprueba("APISIX: ruta fuera del catálogo", !!apisix && apisix.authDetected.startsWith("requerida") && !apisix.matchedApiId, apisix ? `${apisix.path} · clave ${apisix.authDetected}` : "no encontrada");
    const directa = hallazgos.find((f) => f.source === "red" && f.host === "ocultas" && f.path === "/espectro/asignaciones");
    e.comprueba("servicio directo con contrato publicado", !!directa && directa.specFound && directa.personalDataSuspected, directa ? `ocultas${directa.path} · puntaje ${directa.exposureScore}` : "no encontrado");
    const bypass = hallazgos.find((f) => f.source === "red" && f.host === "concesiones-v1" && f.reasons.some((r) => r.includes("sin pasar por el gateway")));
    e.comprueba("backend accesible sin pasar por el gateway", !!bypass, bypass ? `${bypass.host}:${bypass.port ?? ""}${bypass.path}` : "no detectado");
    await desplazarSiHay(c, c.app.getByTestId("table-findings").locator("tbody tr").nth(5));
    const ordenados = hallazgos.length > 1 && hallazgos.every((f, i) => i === 0 || hallazgos[i - 1]!.exposureScore >= f.exposureScore);
    e.comprueba("ordenados por puntaje de exposición", ordenados, hallazgos.length ? `${hallazgos[0]!.exposureScore} → ${hallazgos.at(-1)!.exposureScore} en ${hallazgos.length} hallazgos` : "sin hallazgos");
    await e.esperar(3500); // lectura de la tabla y de las cinco verificaciones

    // ── 4. Reportes ────────────────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_D01[3]!);
    await e.desplazar(-3000).catch(() => undefined);
    let filasCsv = -1;
    try {
      const csvRuta = await c.descargar(c.app.getByTestId("btn-download-discovery-report"), "reporte-exposicion.csv");
      const csv = readFileSync(csvRuta, "utf8").trim().split("\n");
      filasCsv = csv.length - 1;
      c.log(`CSV descargado desde la Consola: ${filasCsv} filas`, "tenue");
      for (const l of csv.slice(0, 4)) c.log(`  ${corto(l, 150)}`);
    } catch (err) {
      c.log(`no se pudo descargar el CSV: ${err instanceof Error ? err.message.split("\n")[0] : err}`, "mal");
    }
    e.comprueba("CSV con todos los hallazgos", filasCsv === hallazgos.length && filasCsv > 0, `${filasCsv} filas de ${hallazgos.length} hallazgos`);
    const res = await fetch(`${CONSOLA_API}/discovery/report?format=pdf`, { headers: { authorization: `Bearer ${operadora}` } });
    const bytes = Buffer.from(await res.arrayBuffer());
    const pdfRuta = join(c.archivos, "reporte-exposicion.pdf");
    writeFileSync(pdfRuta, bytes);
    c.log(`carla.operacion → GET /api/v1/discovery/report?format=pdf → HTTP ${res.status} · ${res.headers.get("content-type")} · ${bytes.length} bytes`, "cmd");
    const esPdf = res.status === 200 && bytes.subarray(0, 5).toString() === "%PDF-";
    e.comprueba("PDF generado por la Consola", esPdf, `${Math.round(bytes.length / 1024)} KB`);
    if (esPdf) {
      // Parte superior de la primera página, a tamaño legible.
      await ejecutar("pdftoppm", ["-png", "-r", "120", "-f", "1", "-l", "1", "-x", "60", "-y", "40", "-W", "900", "-H", "640", "-singlefile", pdfRuta, join(c.archivos, "reporte-p1")]).catch(() => undefined);
      c.imagen(join(c.archivos, "reporte-p1.png"), "Reporte de exposición en PDF entregado por la Consola (página 1, parte superior)");
      await c.vista("panel-completo");
      await e.esperar(6000);
    }

    // ── 5. check-d01 ───────────────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_D01[4]!);
    await c.vista("terminal");
    const v = await c.ejecutarComando("pnpm", ["--silent", "--filter", "@nexo/lab-bootstrap", "check:d01"], { cwd: desdeRaiz(), mostrar: "pnpm --silent --filter @nexo/lab-bootstrap check:d01" });
    const aprobadas = v.salida.filter((l) => /│\s*true\s*│?/.test(l) || /^\s*✓/.test(l)).length;
    e.comprueba("check-d01 aprobado", v.codigo === 0, v.salida.length ? `código 0 · ${aprobadas} pruebas` : `código ${v.codigo}`);
    await c.vista("dividido");
    await c.ir("/descubrimiento");
    await aparece(c.app.getByTestId("table-findings"), 15_000);
    await e.esperar(2000);

    const t = scan?.totals ?? {};
    return {
      medido: `${t.endpoints ?? hallazgos.length} endpoints detectados en ${seg(segEscaneo, 0)}: ${t.noGobernados ?? "?"} no gobernados y ${t.riesgoAlto ?? "?"} de riesgo alto, con reporte CSV y PDF`,
      datos: { segundosEscaneo: Math.round(segEscaneo * 10) / 10, endpoints: t.endpoints, noGobernados: t.noGobernados, riesgoAlto: t.riesgoAlto, maxPuntaje: hallazgos[0]?.exposureScore },
    };
  },
};
