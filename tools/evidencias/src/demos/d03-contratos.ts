/**
 * D-03 · Validación automática de contratos OpenAPI contra una guía de estilo institucional configurable,
 * ejecutada en el pipeline y bloqueante ante incumplimiento. El paso de CI valida los contratos versionados; un
 * contrato que no cumple no se promueve (nexo-ctl api deploy termina con código 2 y nada llega a WSO2); si
 * alguien lo carga a mano, la política de gobierno de WSO2 bloquea su despliegue; corregido, el pipeline lo
 * publica; y la institución puede endurecer la guía y el pipeline vuelve a bloquear.
 * Cada comando se muestra exactamente como se ejecuta (pnpm … nexo-ctl). Las validaciones que no tocan el
 * laboratorio (lint y el deploy que se bloquea antes de WSO2) corren de verdad también en ensayo.
 * Duración estimada: ≈ 100 s (ver ayudas-d.test.ts).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Demo } from "../lib/grabador.js";
import { escaparHtml } from "../lib/grabador.js";
import { desdeRaiz } from "../lib/entorno.js";
import { wso2 } from "../lib/lab.js";
import { esperarHasta } from "./comun.js";
import {
  abrir,
  agendaDe,
  ampliar,
  aparece,
  comando,
  lineaShell,
  argsNexoCtl,
  moverSiHay,
  nexoCtl,
  type PasoGuion,
} from "./ayudas-d.js";
import { prepararEnsayoD } from "./d0x-ensayo.js";

const NOMBRE = "ReportesInternos";
const GUIA = desdeRaiz("wso2/apim/governance/guia-estilo-institucional.yaml");

const API_YAML = `name: ${NOMBRE}
version: 1.0.0
context: /reportes-internos
description: Reportes internos de fiscalización (datos sintéticos de laboratorio).
type: HTTP
contract: openapi.yaml
owner:
  business: División de Fiscalización (sintético)
  businessEmail: fiscalizacion@ejemplo.invalid
  technical: Equipo DevOps (sintético)
  technicalEmail: devops@ejemplo.invalid
metadata:
  proposito: Consultar reportes internos de fiscalización
  audiencia: interna
  clasificacion: interna
security: [oauth2]
keyManagers: [Keycloak]
policies: [Interno]
endpoints:
  dev: http://ocultas:7001
environments:
  dev: [Desarrollo]
`;

/** El contrato corregido: cumple todas las reglas de error; las operaciones no llevan tags (solo advertencia). */
const CORREGIDO = `openapi: 3.0.3
info:
  title: Reportes Internos
  version: 1.0.0
  description: Reportes internos de fiscalización de servicios de telecomunicaciones.
  contact:
    name: División de Fiscalización (sintético)
    email: fiscalizacion@ejemplo.invalid
servers:
  - url: https://dev.nexo.lab:8243/reportes-internos/1.0.0
paths:
  /reportes:
    get:
      operationId: listarReportes
      summary: Lista los reportes internos
      responses:
        "200": { description: Reportes }
  /reportes/{id}:
    get:
      operationId: obtenerReporte
      summary: Obtiene un reporte
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200": { description: Reporte }
        "404": { description: No existe }
components:
  securitySchemes:
    oauth2:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: http://keycloak:8080/realms/nexo/protocol/openid-connect/token
          scopes: {}
security:
  - oauth2: []
`;

export const PASOS_D03: PasoGuion[] = [
  {
    titulo: "La guía de estilo y el paso del pipeline que la aplica",
    quePasa:
      "Un archivo define las reglas de los contratos de API: nombres, seguridad y documentación. El pipeline valida con ellas cada contrato versionado.",
    porQueImporta: "Las reglas se aplican siempre igual y de forma automática, no según quién revise.",
    comprueba: ["los contratos versionados cumplen la guía"],
    estimadoS: 14,
  },
  {
    titulo: "Contrato que no cumple: el pipeline bloquea la promoción",
    quePasa:
      "Se intenta desplegar un contrato con errores. La validación lo rechaza regla por regla, el pipeline termina con error y nada llega al gateway.",
    porQueImporta: "Un contrato mal hecho no puede llegar a producción por descuido.",
    comprueba: ["pipeline bloqueado (código de salida 2)", "nada llegó a WSO2"],
    estimadoS: 13,
  },
  {
    titulo: "Carga manual: la política de gobierno de WSO2 también bloquea",
    quePasa:
      "Si alguien se salta el pipeline y carga el contrato a mano en WSO2, la política de gobierno impide desplegarlo e informa cada regla incumplida.",
    porQueImporta: "El control no depende de usar el pipeline: también protege la puerta manual.",
    comprueba: ["WSO2 bloquea el despliegue del contrato no conforme"],
    estimadoS: 20,
  },
  {
    titulo: "Contrato corregido: validado, versionado y publicado",
    quePasa:
      "Se corrigen rutas, contacto y seguridad: OAuth en vez de usuario y clave. El pipeline lo valida, crea la revisión y lo publica en Desarrollo.",
    porQueImporta: "Cumplir la guía es el único camino para publicar, y cada publicación queda versionada.",
    comprueba: ["contrato corregido promovido y publicado"],
    estimadoS: 22,
  },
  {
    titulo: "La guía es configurable: una regla más estricta vuelve a bloquear",
    quePasa:
      "La institución decide exigir etiquetas en cada operación. Con esa regla endurecida, el mismo contrato corregido se rechaza.",
    porQueImporta: "La institución ajusta sus reglas cuando lo necesita, sin cambiar el producto.",
    comprueba: ["con la regla endurecida el contrato se rechaza"],
    estimadoS: 12,
  },
];

async function borrarApi() {
  const w = wso2();
  for (const a of ((await w.publisher.listApis(`name:"${NOMBRE}"`)).list ?? []).filter(
    (x) => x.name === NOMBRE,
  )) {
    await w.request({ method: "DELETE", path: `/api/am/publisher/v4/apis/${a.id}` });
  }
}

/**
 * Cifras exactas del paso de CI («nexo-ctl contratos»): cuántos validó (línea «Contratos: N validados»), cuántos
 * contratos OpenAPI/AsyncAPI quedaron con 0 errores, cuántos esquemas GraphQL (no pasan por la guía de estilo)
 * y cuántas advertencias sumaron.
 */
export function resumenContratos(salida: readonly string[]): {
  validados?: number;
  sinErrores: number;
  esquemas: number;
  advertencias: number;
} {
  const validados = salida.map((l) => /Contratos: (\d+) validados/.exec(l)?.[1]).find(Boolean);
  let sinErrores = 0;
  let advertencias = 0;
  for (const l of salida) {
    const m = /Resultado: (\d+) errores, (\d+) advertencias/.exec(l);
    if (!m) continue;
    if (m[1] === "0") sinErrores++;
    advertencias += Number(m[2]);
  }
  const esquemas = salida.filter((l) => /Esquema GraphQL .* válido/.test(l)).length;
  return { ...(validados ? { validados: Number(validados) } : {}), sinErrores, esquemas, advertencias };
}

const SIN_RUTA = (l: string) =>
  l.replace(/\/(tmp|home)\/[^ ]*\/(reportes-internos|wso2\/apim\/apis)\//, "…/$2/");

export const d03: Demo = {
  id: "D-03",
  archivo: "D-03_contratos_pipeline",
  nombre: "Validación de contratos OpenAPI contra la guía de estilo, bloqueante en el pipeline",
  afirmacion:
    "Cada contrato OpenAPI se valida automáticamente contra la guía de estilo institucional, configurable por la institución: el pipeline bloquea la promoción si no cumple y la política de gobierno de WSO2 bloquea su despliegue aunque se cargue a mano.",
  pasos: PASOS_D03.length,
  agenda: agendaDe(PASOS_D03),

  async preparar(c) {
    await prepararEnsayoD(c);
    await borrarApi();
    // En ensayo los portales son simulados: si su inicio de sesión falla, el ensayo sigue (en el laboratorio, no).
    if (c.estudio.ensayo)
      await c
        .ingresarWso2("publisher")
        .catch((err: unknown) =>
          c.avisar(`(ensayo) Publisher: ${err instanceof Error ? err.message.split("\n")[0] : err}`),
        );
    else await c.ingresarWso2("publisher");
    return ["la API de ejemplo ReportesInternos no existe en WSO2"];
  },

  async ejecutar(c) {
    const e = c.estudio;
    const w = wso2();
    const dir = join(c.archivos, "reportes-internos");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "api.yaml"), API_YAML);
    const malo = readFileSync(desdeRaiz("wso2/apim/apis/_ejemplos/contrato-incumple.yaml"), "utf8");
    const listar = async () =>
      ((await w.publisher.listApis(`name:"${NOMBRE}"`)).list ?? []).filter((a) => a.name === NOMBRE);

    // ── 1. Guía y paso de CI ───────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_D03[0]!);
    const guia = parse(readFileSync(GUIA, "utf8")) as {
      rules: Record<string, { description: string; severity: string }>;
    };
    const visibles = Object.entries(guia.rules).filter(([id]) => !/-(put|post|delete|patch)$/.test(id));
    const filas = visibles
      .map(
        ([id, r]) =>
          `<tr><td><code>${escaparHtml(id.replace(/-get$/, ""))}</code></td><td class="${r.severity === "error" ? "mal" : ""}">${r.severity}</td><td>${escaparHtml(r.description)}</td></tr>`,
      )
      .join("");
    // Las reglas que la guía repite por método HTTP (…-get, …-post, …) van en una sola fila.
    c.panel(
      `<h3>wso2/apim/governance/guia-estilo-institucional.yaml · ${Object.keys(guia.rules).length} reglas (${visibles.length} filas: las que se repiten por método HTTP van una vez)</h3><table><tr><th>Regla</th><th>Severidad</th><th>Qué exige</th></tr>${filas}</table>`,
    );
    await c.vista("terminal-panel");
    c.log(
      ".github/workflows/ci.yml · trabajo «contratos» (bloqueante): pnpm --filter @nexo/nexo-ctl contratos",
      "tenue",
    );
    const ci = await comando(c, "pnpm --silent --filter @nexo/nexo-ctl contratos", {
      cwd: desdeRaiz(),
      filtro: (l) =>
        /Resultado|Contratos:|Esquema|Validación del contrato/.test(l) ? SIN_RUTA(l) : undefined,
    });
    c.log(`(código de salida ${ci.codigo})`, ci.codigo === 0 ? "tenue" : "mal");
    const r = resumenContratos(ci.salida);
    if (r.advertencias > 0)
      c.log(
        `# ${r.advertencias} advertencias de la guía, que no bloquean: el pipeline se detiene solo ante errores`,
        "tenue",
      );
    e.comprueba(
      "los contratos versionados cumplen la guía",
      ci.codigo === 0,
      r.validados !== undefined
        ? `código ${ci.codigo} · ${r.validados} validados: ${r.sinErrores} contratos con 0 errores${r.esquemas ? ` y ${r.esquemas} esquema GraphQL válido` : ""}`
        : `código ${ci.codigo}`,
    );

    // ── 2. Contrato que no cumple: pipeline bloqueado ──────────────────────────────────────────────
    await abrir(c, PASOS_D03[1]!);
    writeFileSync(join(dir, "openapi.yaml"), malo);
    await c.vista("dividido");
    await c.ir("https://apim:9443/publisher/apis");
    // El cursor sale de las tarjetas (no deja abierta la ayuda de ninguna) y queda en el total de APIs.
    await moverSiHay(c, c.app.getByText(/Total:\s*\d+\s*APIs?/).first(), 8000);
    const r1 = await nexoCtl(c, ["api", "deploy", dir, "-s", "dev", "-m", "Primera versión"], {
      local: true,
      filtro: SIN_RUTA,
    });
    const enWso2 = await listar();
    e.comprueba(
      "pipeline bloqueado (código de salida 2)",
      r1.codigo === 2 && r1.salida.some((l) => l.includes("PROMOCIÓN BLOQUEADA")),
      `código ${r1.codigo} · ${r1.salida.filter((l) => /\[error\]/.test(l)).length} errores de la guía`,
    );
    e.comprueba("nada llegó a WSO2", enWso2.length === 0, `${enWso2.length} APIs ${NOMBRE} en el Publisher`);
    await c.app.reload();
    await e.esperar(1500);

    // ── 3. Carga manual: WSO2 bloquea el despliegue ────────────────────────────────────────────────
    await abrir(c, PASOS_D03[2]!);
    c.log(
      "admin → POST https://apim:9443/api/am/publisher/v4/apis/import-openapi   # carga manual en WSO2, sin pasar por el pipeline",
      "cmd",
    );
    const manual = await w.publisher.importOpenApi(malo, {
      name: NOMBRE,
      version: "1.0.0",
      context: "/reportes-internos",
      policies: ["Interno"],
      endpointConfig: {
        endpoint_type: "http",
        production_endpoints: { url: "http://ocultas:7001" },
        sandbox_endpoints: { url: "http://ocultas:7001" },
      },
    } as never);
    const idManual = String((manual as { id?: string }).id ?? "");
    c.log(`  API creada en el Publisher (${idManual.slice(0, 8)}…), sin desplegar`, "tenue");
    // La ficha de la API se abre (y termina de cargar) antes de intentar desplegarla.
    if (idManual) {
      await c.app.goto(`https://apim:9443/publisher/apis/${idManual}/overview`).catch(() => undefined);
      await aparece(c.app.getByText(NOMBRE).first(), 20_000);
    }
    c.log(
      `admin → POST https://apim:9443/api/am/publisher/v4/apis/${idManual.slice(0, 8)}…/revisions   # revisión para desplegarla`,
      "cmd",
    );
    let bloqueo = "";
    let estadoHttp: number | undefined;
    let creoRevision = false;
    try {
      await w.publisher.createRevision(idManual, "carga manual");
      creoRevision = true;
    } catch (err) {
      bloqueo = (err as { body?: string }).body ?? String(err);
      const st = (err as { status?: unknown }).status;
      estadoHttp = typeof st === "number" ? st : undefined;
    }
    const detalle = (() => {
      try {
        const b = JSON.parse(bloqueo) as { code?: number; message?: string; description?: string };
        const v = JSON.parse(b.description ?? "{}") as {
          blockingViolations?: Array<{ ruleName: string; message: string }>;
        };
        return { codigo: b.code, mensaje: b.message ?? "", violaciones: v.blockingViolations ?? [] };
      } catch {
        return {
          codigo: undefined,
          mensaje: bloqueo.slice(0, 120),
          violaciones: [] as Array<{ ruleName: string; message: string }>,
        };
      }
    })();
    // El 903300 es el código de error de WSO2 (no un estado HTTP): se muestran los dos.
    c.log(
      creoRevision
        ? "  HTTP 201 · revisión creada"
        : `  HTTP ${estadoHttp ?? "?"} · código WSO2 ${detalle.codigo ?? "?"}: ${detalle.mensaje}`,
      creoRevision ? "mal" : "aviso",
    );
    // WSO2 puede informar la misma regla y el mismo mensaje más de una vez: se agrupan y se dice cuántas.
    const distintas = new Map<string, number>();
    for (const v of detalle.violaciones) {
      const k = `${v.ruleName}: ${v.message}`;
      distintas.set(k, (distintas.get(k) ?? 0) + 1);
    }
    for (const [k, veces] of [...distintas].slice(0, 7))
      c.log(`  [bloqueante] ${k}${veces > 1 ? ` (informada ${veces} veces)` : ""}`, "aviso");
    if (idManual) {
      const cumplimiento = c.app.getByText("Compliance", { exact: true }).first();
      if (await aparece(cumplimiento, 6000)) {
        await e.clic(cumplimiento);
        const infraccion = c.app.getByText(/violation|infracci|incumpl/i).first();
        if (await aparece(infraccion, 10_000)) await ampliar(c, infraccion, 2400);
      }
    }
    e.comprueba(
      "WSO2 bloquea el despliegue del contrato no conforme",
      !creoRevision && /governance/i.test(detalle.mensaje) && detalle.violaciones.length > 0,
      `${detalle.violaciones.length} violaciones bloqueantes de ${new Set(detalle.violaciones.map((v) => v.ruleName)).size} reglas`,
    );
    if (idManual) {
      await w
        .request({ method: "DELETE", path: `/api/am/publisher/v4/apis/${idManual}` })
        .catch(() => undefined);
      c.log("  (se elimina la API cargada a mano)", "tenue");
    }

    // ── 4. Contrato corregido: publicado ───────────────────────────────────────────────────────────
    await abrir(c, PASOS_D03[3]!);
    writeFileSync(join(dir, "openapi.yaml"), CORREGIDO);
    c.log(
      "cambios: rutas en kebab-case, contacto, descripción, versión semántica, summary, HTTPS y OAuth en vez de HTTP basic",
      "tenue",
    );
    const r2 = await nexoCtl(c, ["api", "deploy", dir, "-s", "dev", "-m", "Contrato corregido"], {
      filtro: SIN_RUTA,
      simulado: { codigo: 0, salida: ["(ensayo) Resultado: 0 errores, 2 advertencias, 0 info."] },
      ensayoPublica: NOMBRE,
    });
    // La búsqueda del Publisher indexa con unos segundos de retraso.
    const encontrada = await esperarHasta(
      async () => (await listar())[0],
      (a) => !!a,
      c.estudio.ensayo ? 3 : 30,
      1500,
    );
    const creada = encontrada?.valor;
    // Primero la ficha en el Publisher con su estado a la vista; después la verificación y la ampliación.
    const estadoPublicado = c.app.getByText(/PUBLISHED|Published|Publicad/).first();
    let publicadoEnPantalla = false;
    if (creada) {
      await c.app.goto(`https://apim:9443/publisher/apis/${creada.id}/overview`).catch(() => undefined);
      publicadoEnPantalla = await aparece(estadoPublicado, 20_000);
    }
    e.comprueba(
      "contrato corregido promovido y publicado",
      r2.codigo === 0 && !!creada && creada.lifeCycleStatus === "PUBLISHED",
      creada ? `${creada.lifeCycleStatus} en Desarrollo` : `código ${r2.codigo}`,
    );
    if (publicadoEnPantalla) await ampliar(c, estadoPublicado, 2400);

    // ── 5. Guía endurecida ─────────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_D03[4]!);
    await c.vista("terminal");
    const guia2 = parse(readFileSync(GUIA, "utf8")) as { rules: Record<string, { severity: string }> };
    for (const id of Object.keys(guia2.rules))
      if (id.startsWith("nexo-etiquetas-")) guia2.rules[id]!.severity = "error";
    const guiaPropia = join(c.archivos, "guia-institucion.yaml");
    writeFileSync(guiaPropia, stringify(guia2));
    c.log("guia-institucion.yaml: las reglas nexo-etiquetas-* pasan de «warn» a «error»", "tenue");
    const r3 = await nexoCtl(c, ["api", "lint", join(dir, "openapi.yaml"), "-r", guiaPropia], {
      local: true,
      filtro: SIN_RUTA,
    });
    e.comprueba(
      "con la regla endurecida el contrato se rechaza",
      r3.codigo === 2 && r3.salida.some((l) => /nexo-etiquetas/.test(l)),
      `código ${r3.codigo} · ${r3.salida.filter((l) => /\[error\] nexo-etiquetas/.test(l)).length} operaciones sin etiquetas`,
    );
    await e.esperar(2000);

    return {
      medido: `contrato no conforme bloqueado por el pipeline (código 2, nada llegó a WSO2) y por la política de gobierno de WSO2 (${detalle.violaciones.length} violaciones); corregido, se publicó; con la guía endurecida, se rechazó`,
      datos: {
        violacionesWso2: detalle.violaciones.length,
        codigoBloqueo: r1.codigo,
        codigoEndurecida: r3.codigo,
        comandoDeploy: `pnpm ${lineaShell(argsNexoCtl(["api", "deploy", "<proyecto>", "-s", "dev"]))}`,
      },
    };
  },

  async limpiar() {
    await borrarApi();
  },
};
