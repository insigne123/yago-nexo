/**
 * Ayudas de los guiones D-01 a D-05 y BT-005 (narración V11, veracidad V12, cursor y zoom).
 *
 * Reglas que estas funciones ayudan a cumplir:
 *   - cada paso se declara con su narración completa (titulo, quePasa, porQueImporta, comprueba) en una tabla
 *     PASOS del guion; la agenda de la portada sale de esa misma tabla (agendaDe), así no se desalinean;
 *   - la duración estimada de cada paso queda escrita junto a su narración (estimadoS) y revisarGuion()
 *     comprueba, también en las pruebas unitarias, que cada paso dure ≥ 7 s y el video ≤ 240 s;
 *   - lo que la terminal muestra como comando es exactamente lo que se ejecuta (comando()), y lo que el panel
 *     muestra como verificado sale de una medición (estado HTTP, cuerpo, métrica, registro), nunca de un texto
 *     fijo;
 *   - los backends de demostración se nombran por su contenedor (concesiones-v1 / concesiones-v2), nunca solo
 *     por su número de versión, para que no se confundan con la versión del producto.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fetch } from "undici";
import type { Locator, Page } from "playwright-core";
import { runLoad, type LoadResult, type LoadSecond } from "../../../lab-bootstrap/src/load.js";
import { ENV_HIJOS, type Contexto, type DefinicionPaso, type Objetivo, type TipoLinea } from "../lib/grabador.js";
import { desdeRaiz } from "../lib/entorno.js";
import { ENSAYO, reescribirUrlEnsayo, wso2 } from "../lib/lab.js";
import { CIERRE_S, LECTURA_COMPROBADO_MS, PASO_MINIMO_S, PORTADA_S, TOPE_VIDEO_S } from "../lib/ritmo.js";

// ── Narración y duración ──────────────────────────────────────────────────────────────────────────────

/** Paso del guion: la narración que se publica en el panel más su duración estimada (segundos). */
export interface PasoGuion extends DefinicionPaso {
  /** Duración estimada del paso en el laboratorio (segundos, incluye las esperas de medición). */
  estimadoS: number;
}

/** Títulos de los pasos (agenda de la portada y barra de capítulos). */
export const agendaDe = (pasos: readonly PasoGuion[]): string[] => pasos.map((p) => p.titulo);

/** Definición que recibe estudio.paso() (sin la estimación). */
export function definicion(p: PasoGuion): DefinicionPaso {
  const { estimadoS: _e, ...def } = p;
  return def;
}

/**
 * Duración estimada del video: portada + cada paso (al menos 7 s, más la lectura de su última verificación)
 * + cierre. Es la cifra que se compara con el tope de 240 s.
 */
export function duracionEstimada(pasos: readonly PasoGuion[]): number {
  const lectura = LECTURA_COMPROBADO_MS / 1000;
  const cuerpo = pasos.reduce((s, p) => s + Math.max(PASO_MINIMO_S, p.minimoS ?? 0, p.estimadoS + (p.comprueba?.length ? lectura : 0)), 0);
  return Math.round((PORTADA_S + cuerpo + CIERRE_S) * 10) / 10;
}

/**
 * Largo máximo de cada texto del panel lateral (500 px de ancho: título de 28 px en 3 líneas y cuerpo de 22 px en
 * 4; medido en los fotogramas del ensayo: unas 40 letras por línea). Más largo, el panel lo corta con «…».
 */
export const LARGOS = { titulo: 70, quePasa: 150, porQueImporta: 125, comprueba: 55 } as const;

/** Términos de producto que no se usan solos en la narración (se explican o se nombran por lo que hacen). */
const JERGA = [/\bdeny polic/i, /\bkey manager\b/i, /\bthrottl/i, /\bxDS\b/, /\bsplit[ -]brain\b/i, /\bfailback\b/i, /\bfailover\b/i, /\brollout\b/i];

/**
 * Problemas de un guion frente a las reglas de los videos (V03, V11): pasos de menos de 7 s, video de más de
 * 240 s, textos vacíos o demasiado largos para el panel, jerga sin traducir y agenda desalineada.
 */
export function revisarGuion(pasos: readonly PasoGuion[], agenda?: readonly string[]): string[] {
  const problemas: string[] = [];
  if (!pasos.length) problemas.push("el guion no declara pasos");
  pasos.forEach((p, i) => {
    const n = i + 1;
    if (p.estimadoS < PASO_MINIMO_S) problemas.push(`paso ${n}: estimado ${p.estimadoS} s, menos de ${PASO_MINIMO_S} s`);
    for (const [campo, max] of Object.entries(LARGOS) as Array<[keyof typeof LARGOS, number]>) {
      const valores = campo === "comprueba" ? (p.comprueba ?? []) : [p[campo]];
      for (const v of valores) {
        if (!v || !v.trim()) problemas.push(`paso ${n}: ${campo} vacío`);
        else if ([...v].length > max) problemas.push(`paso ${n}: ${campo} de ${[...v].length} caracteres (máximo ${max})`);
        for (const j of JERGA) if (j.test(v ?? "")) problemas.push(`paso ${n}: ${campo} usa jerga sin traducir (${j.source})`);
      }
    }
    if (!p.comprueba?.length) problemas.push(`paso ${n}: no declara qué se comprueba`);
  });
  const total = duracionEstimada(pasos);
  if (total > TOPE_VIDEO_S) problemas.push(`duración estimada ${total} s, más que el tope de ${TOPE_VIDEO_S} s`);
  if (agenda && agenda.join("\n") !== agendaDe(pasos).join("\n")) problemas.push("la agenda no coincide con los títulos de los pasos");
  return problemas;
}

/** Abre el paso del guion en el estudio (cierra el anterior cuando cumplió su mínimo). */
export function abrir(c: Contexto, p: PasoGuion): Promise<number> {
  return c.estudio.paso(definicion(p));
}

// ── Formato ───────────────────────────────────────────────────────────────────────────────────────────

const NUM = new Intl.NumberFormat("es-CL");
/** 1234 → «1.234». */
export const n = (x: number) => NUM.format(x);
/** 7.04 → «7,0 s». */
export const seg = (s: number, decimales = 1) => `${s.toFixed(decimales).replace(".", ",")} s`;

/**
 * Nombre de un backend de demostración a partir de la versión que informa en x-backend-version. Los números
 * 1.0.0 y 1.1.0 son de la API Concesiones de ejemplo y no tienen relación con la versión del producto.
 */
export const BACKEND: Readonly<Record<string, string>> = { "1.0.0": "concesiones-v1", "1.1.0": "concesiones-v2" };
export const nombreBackend = (version: string) => BACKEND[version] ?? `backend ${version}`;
/** Nombre de un backend a partir de su URL (http://concesiones-v1:7001 → concesiones-v1). */
export const backendDeUrl = (url: string | undefined) => (url ? (/^https?:\/\/([^:/]+)/.exec(url)?.[1] ?? url) : "—");

/** Recorta un texto largo para la terminal. */
export const corto = (t: string, max = 150) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

// ── Comandos reales ───────────────────────────────────────────────────────────────────────────────────

export interface SalidaComando {
  codigo: number;
  salida: string[];
}

/**
 * Ejecuta una línea de shell y la muestra en la terminal EXACTAMENTE como se ejecuta («$ <línea>»), con su
 * salida línea a línea. Las variables (p. ej. $TOKEN) se pasan por el entorno, así el secreto no aparece.
 * En ensayo la línea se ejecuta igual, pero con las URL del laboratorio desviadas al servidor de ensayo (curl
 * y utilidades locales); con `soloLaboratorio` no se ejecuta y se devuelve `simulado`.
 */
export async function comando(
  c: Contexto,
  linea: string,
  o: {
    env?: Record<string, string>;
    cwd?: string;
    filtro?: (l: string) => string | undefined;
    tipo?: (l: string) => TipoLinea;
    /** No mostrar la salida en la terminal (se devuelve igual). */
    silencioso?: boolean;
    /** El comando necesita el laboratorio (nexo-ctl, docker): en ensayo no se ejecuta. */
    soloLaboratorio?: boolean;
    simulado?: SalidaComando;
  } = {},
): Promise<SalidaComando> {
  c.log(`$ ${linea}`, "cmd");
  if (c.estudio.ensayo && o.soloLaboratorio) {
    c.log("(ensayo: no hay laboratorio; el comando no se ejecuta)", "tenue");
    const s = o.simulado ?? { codigo: 0, salida: [] };
    if (!o.silencioso) for (const l of s.salida) c.log(l, o.tipo?.(l));
    return s;
  }
  const real = c.estudio.ensayo ? lineaEnsayo(linea) : linea;
  const base = ENV_HIJOS();
  // El laboratorio (y el servidor de ensayo) es local: nunca por un proxy de salida.
  const np = [base.NO_PROXY, "localhost", "127.0.0.1"].filter(Boolean).join(",");
  const hijo = spawn("sh", ["-c", real], { cwd: o.cwd, env: { ...base, NO_PROXY: np, no_proxy: np, ...o.env }, stdio: ["ignore", "pipe", "pipe"] });
  const salida: string[] = [];
  const procesar = (bruta: string) => {
    salida.push(bruta);
    if (o.silencioso) return;
    const l = o.filtro ? o.filtro(bruta) : bruta;
    if (l !== undefined) c.log(corto(l, 170), o.tipo?.(l));
  };
  createInterface({ input: hijo.stdout }).on("line", procesar);
  createInterface({ input: hijo.stderr }).on("line", procesar);
  const codigo = await new Promise<number>((ok) => hijo.on("close", (k) => ok(k ?? 1)));
  return { codigo, salida };
}

/** En ensayo, reescribe las URL del laboratorio de una línea de shell hacia el servidor de ensayo. */
export function lineaEnsayo(linea: string, base: string | undefined = ENSAYO): string {
  if (!base) return linea;
  return linea.replace(/(https?:\/\/(?:apim:(?:9443|8243)|keycloak:8080|localhost:(?:8090|7011|7012|9200|9093))[^\s'"]*)/g, (u) => {
    if (u.startsWith("http://localhost:9200")) return `${base}/d0x/opensearch${u.slice("http://localhost:9200".length)}`;
    if (u.startsWith("http://localhost:9093")) return `${base}/d0x/alertmanager${u.slice("http://localhost:9093".length)}`;
    return reescribirUrlEnsayo(u, base);
  });
}

/** Código HTTP que curl escribe al final («HTTP 401»). */
export function codigoHttp(salida: readonly string[]): number | undefined {
  for (let i = salida.length - 1; i >= 0; i--) {
    const m = /^HTTP (\d{3})$/.exec(salida[i]!.trim());
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * curl real contra el gateway, mostrado tal cual: `curl -sk -w '\nHTTP %{http_code}\n' [-H "Authorization:
 * Bearer $TOKEN"] <url>`. Devuelve el código y el cuerpo que recibió el consumidor.
 */
export async function curl(c: Contexto, url: string, o: { token?: string; comentario?: string } = {}): Promise<{ status?: number; cuerpo: string }> {
  const auth = o.token ? ` -H "Authorization: Bearer $TOKEN"` : "";
  const linea = `curl -sk -w '\\nHTTP %{http_code}\\n'${auth} ${url}${o.comentario ? `   # ${o.comentario}` : ""}`;
  const r = await comando(c, linea, { env: o.token ? { TOKEN: o.token } : {}, silencioso: true });
  const status = codigoHttp(r.salida);
  const cuerpo = r.salida.filter((l) => !/^HTTP \d{3}$/.test(l.trim())).join("\n").trim();
  c.log(`  ${corto(cuerpo || "(sin cuerpo)", 160)}`, "tenue");
  c.log(`  HTTP ${status ?? "sin respuesta"}`, status && status < 300 ? "ok" : "aviso");
  return { ...(status !== undefined ? { status } : {}), cuerpo };
}

// ── Servicios del laboratorio sin dispatcher propio (en ensayo, a las rutas /d0x del servidor de ensayo) ─

const OPENSEARCH = () => (ENSAYO ? `${ENSAYO}/d0x/opensearch` : (process.env.NEXO_OPENSEARCH_URL ?? "http://localhost:9200"));
const ALERTMANAGER = () => (ENSAYO ? `${ENSAYO}/d0x/alertmanager` : (process.env.NEXO_ALERTMANAGER_URL ?? "http://localhost:9093"));

/** Búsqueda en la analítica del gateway (OpenSearch del laboratorio). */
export async function buscarAnalitica<T = unknown>(consulta: unknown, indice = "nexo-apim-metrics-*"): Promise<T> {
  const r = await fetch(`${OPENSEARCH()}/${indice}/_search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(consulta) });
  return (await r.json()) as T;
}

/** URL de OpenSearch tal como se muestra en la terminal. */
export const URL_OPENSEARCH = "http://localhost:9200";

/** Alertas vigentes en Alertmanager. */
export async function alertasVigentes(): Promise<Array<{ labels: Record<string, string>; annotations: Record<string, string> }>> {
  const r = await fetch(`${ALERTMANAGER()}/api/v2/alerts`);
  return (await r.json()) as Array<{ labels: Record<string, string>; annotations: Record<string, string> }>;
}

/**
 * Ventanas (de `ventanaS` segundos, alineadas al reloj como las del guardián) con tráfico de cada aplicación
 * consumidora en la API indicada, dentro de las últimas `n` ventanas. Es lo que el guardián usa como línea base.
 */
export async function ventanasConTrafico(o: { apiNombre: string; aplicaciones: readonly string[]; ventanaS?: number; n?: number; finMs?: number }): Promise<Record<string, { ventanas: number; llamadas: number; porVentana: number }>> {
  const v = o.ventanaS ?? 30;
  const total = o.n ?? 61;
  const fin = Math.floor((o.finMs ?? Date.now()) / (v * 1000)) * v * 1000;
  const desde = fin - total * v * 1000;
  const q = {
    size: 0,
    query: { bool: { filter: [{ range: { "@timestamp": { gte: desde, lt: fin, format: "epoch_millis" } } }, { term: { "apiName.keyword": o.apiNombre } }, { terms: { "applicationName.keyword": [...o.aplicaciones] } }] } },
    aggs: { app: { terms: { field: "applicationName.keyword", size: 20 }, aggs: { v: { date_histogram: { field: "@timestamp", fixed_interval: `${v}s`, min_doc_count: 1 } } } } },
  };
  const r = await buscarAnalitica<{ aggregations?: { app?: { buckets: Array<{ key: string; doc_count: number; v: { buckets: unknown[] } }> } } }>(q);
  const out: Record<string, { ventanas: number; llamadas: number; porVentana: number }> = {};
  for (const a of o.aplicaciones) out[a] = { ventanas: 0, llamadas: 0, porVentana: 0 };
  for (const b of r.aggregations?.app?.buckets ?? []) {
    const ventanas = b.v.buckets.length;
    out[b.key] = { ventanas, llamadas: b.doc_count, porVentana: ventanas ? Math.round(b.doc_count / ventanas) : 0 };
  }
  return out;
}

/**
 * Aplicación consumidora aprovisionada por el Dev Portal (idempotente): la crea, emite sus credenciales en
 * Keycloak y la suscribe a la API, aprobando los flujos institucionales como lo hace la Consola.
 */
export async function asegurarConsumidor(nombre: string, descripcion: string, apiNombre: string, plan: string): Promise<string[]> {
  const w = wso2();
  const notas: string[] = [];
  const aprobar = async (tipo: string, motivo: string) => {
    for (const p of (await w.admin.listWorkflows(tipo)).list) await w.admin.resolveWorkflow(p.referenceId, "APPROVED", motivo);
  };
  let app = (await w.devportal.listApplications()).list.find((a) => a.name === nombre);
  if (!app) {
    app = await w.devportal.createApplication(nombre, descripcion);
    await aprobar("AM_APPLICATION_CREATION", "Aprobado para la demostración");
    notas.push(`aplicación ${nombre} creada y aprobada`);
  }
  const llave = (await w.devportal.listKeys(app.applicationId)).list.find((k) => k.keyManager === "Keycloak" && k.keyType === "PRODUCTION");
  if (!llave?.consumerKey) {
    await w.devportal.generateKeys(app.applicationId, "Keycloak", ["client_credentials"], "PRODUCTION", {
      subject_type: "public",
      token_endpoint_auth_method: "client_secret_basic",
      tls_client_certificate_bound_access_tokens: "false",
    });
    await aprobar("AM_APPLICATION_REGISTRATION_PRODUCTION", "Aprobado para la demostración");
    notas.push(`credenciales de ${nombre} emitidas en Keycloak`);
  }
  const api = (await w.devportal.listApis()).list.find((a) => a.name === apiNombre);
  if (!api) throw new Error(`no existe la API ${apiNombre} en el Dev Portal`);
  const subs = (await w.devportal.listSubscriptions(app.applicationId)).list;
  if (!subs.some((s) => s.apiId === api.id || s.apiInfo?.id === api.id)) {
    await w.devportal.subscribe(app.applicationId, api.id, plan);
    await aprobar("AM_SUBSCRIPTION_CREATION", "Aprobado para la demostración");
    notas.push(`${nombre} suscrita a ${apiNombre} con el plan ${plan}`);
  }
  return notas;
}

// ── Pantalla ──────────────────────────────────────────────────────────────────────────────────────────

/** ¿Aparece el objetivo antes de `ms`? (no lanza). */
export async function aparece(loc: Locator, ms = 15_000): Promise<boolean> {
  return loc
    .first()
    .waitFor({ state: "visible", timeout: ms })
    .then(() => true)
    .catch(() => false);
}

/**
 * Amplía en vivo un elemento clave (valor que cambia, mensaje de rechazo, gráfico) durante `ms` y vuelve a la
 * vista completa. Si el elemento no está a la vista, no amplía (y avisa) en vez de detener la grabación.
 */
export async function ampliar(c: Contexto, objetivo: Objetivo, ms = 2600, factor?: number): Promise<boolean> {
  if (typeof objetivo !== "string" && "first" in objetivo && !(await aparece(objetivo, 4000))) {
    c.avisar(`ampliación omitida: el elemento no está a la vista`);
    return false;
  }
  try {
    await c.estudio.zoom(objetivo, { ms, ...(factor ? { factor } : {}) });
    return true;
  } catch (e) {
    c.avisar(`ampliación omitida: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    await c.estudio.zoomFuera();
    return false;
  }
}

/** Clic visible en un control que puede no existir en el ensayo (en el laboratorio, si falta, es error). */
export async function clicSiHay(c: Contexto, loc: Locator, o: { pagina?: Page; ms?: number } = {}): Promise<boolean> {
  if (!(await aparece(loc, o.ms ?? (c.estudio.ensayo ? 3000 : 20_000)))) {
    if (c.estudio.ensayo) {
      c.log("(ensayo: el control no existe en la página simulada)", "tenue");
      return false;
    }
    throw new Error(`no apareció el control ${String(loc)}`);
  }
  await c.estudio.clic(loc, o.pagina ? { pagina: o.pagina } : {});
  return true;
}

// ── Carga continua del consumidor (con nombres de backend, no números de versión) ────────────────────────

export interface CargaD {
  detener(): void;
  resultado: Promise<LoadResult>;
  segundos: LoadSecond[];
  /** Errores acumulados que vio el consumidor. */
  errores(): number;
  /** Llamadas atendidas por cada backend (concesiones-v1, concesiones-v2). */
  porBackend(): Record<string, number>;
}

/**
 * Carga a través del gateway con el generador de las verificaciones del laboratorio (tools/lab-bootstrap,
 * runLoad). Cada `cadaSeg` segundos escribe en la terminal lo que vio el consumidor, con el nombre del backend
 * que respondió (x-backend-version 1.0.0 → concesiones-v1, 1.1.0 → concesiones-v2).
 */
export function cargaContinua(c: Contexto, o: { url: string; rps: number; segundos: number; etiqueta: string; cadaSeg?: number; app?: string }): CargaD {
  const ctrl = new AbortController();
  const vistos: LoadSecond[] = [];
  const cada = o.cadaSeg ?? 4;
  let tramo = { ok: 0, err: 0, b: {} as Record<string, number> };
  const total: Record<string, number> = {};
  let errores = 0;
  c.log(`carga: ${o.app ?? "OperadorDemo"} llama ${o.rps} veces por segundo a ${o.url.replace(/^https:\/\/apim:8243/, "gateway ")}   # ${o.etiqueta}`, "tenue");
  const resultado = runLoad({
    url: o.url,
    rps: o.rps,
    seconds: o.segundos,
    signal: ctrl.signal,
    ...(o.app ? { app: o.app } : {}),
    onSecond: (s) => {
      vistos.push(s);
      tramo.ok += s.ok;
      tramo.err += s.errores;
      errores += s.errores;
      for (const [k, v] of Object.entries(s.versiones)) {
        const b = nombreBackend(k);
        tramo.b[b] = (tramo.b[b] ?? 0) + v;
        total[b] = (total[b] ?? 0) + v;
      }
      if ((s.t + 1) % cada === 0) {
        const bs = Object.entries(tramo.b).map(([k, v]) => `${k}:${v}`).join(" ");
        c.log(`consumidor t=${String(s.t + 1).padStart(3)} s · ok ${tramo.ok} · errores ${tramo.err}${bs ? ` · ${bs}` : ""}`, tramo.err ? "mal" : "tenue");
        tramo = { ok: 0, err: 0, b: {} };
      }
    },
  });
  // Si la carga falla (p. ej. sin credenciales), quien la espere recibe el error; sin esperarla no derriba el proceso.
  resultado.catch((err: unknown) => c.avisar(`carga «${o.etiqueta}»: ${err instanceof Error ? err.message : String(err)}`));
  return { detener: () => ctrl.abort(), resultado, segundos: vistos, errores: () => errores, porBackend: () => ({ ...total }) };
}

/** Desplazamiento suave hasta un elemento, solo si existe (no espera 30 s a que aparezca). */
export async function desplazarSiHay(c: Contexto, loc: Locator, ms = 3000): Promise<boolean> {
  if (!(await aparece(loc, ms))) return false;
  await c.estudio.desplazar(loc).catch(() => undefined);
  return true;
}

// ── nexo-ctl tal como se ejecuta ──────────────────────────────────────────────────────────────────────

/** Une argumentos en una línea de shell, con comillas solo donde hacen falta. */
export function lineaShell(args: readonly string[]): string {
  return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`)).join(" ");
}

/** Argumentos de pnpm para correr nexo-ctl con la configuración de etapas del repositorio. */
export const argsNexoCtl = (args: readonly string[]) => ["--silent", "--filter", "@nexo/nexo-ctl", "ctl", "-c", "../../nexo-ctl.config.yaml", ...args];

/**
 * nexo-ctl (la CLI del pipeline) tal como se ejecuta, desde la raíz del repositorio:
 * `pnpm --silent --filter @nexo/nexo-ctl ctl -c ../../nexo-ctl.config.yaml <args>`. La terminal muestra
 * exactamente esa línea. En ensayo no se ejecuta (devuelve `simulado`).
 */
export async function nexoCtl(
  c: Contexto,
  args: readonly string[],
  o: { filtro?: (l: string) => string | undefined; simulado?: SalidaComando; local?: boolean; ensayoPublica?: string } = {},
): Promise<SalidaComando> {
  const todos = argsNexoCtl(args);
  if (o.local) {
    // Validaciones que no tocan el laboratorio (lint, deploy que se bloquea antes de llegar a WSO2): se
    // ejecutan de verdad también en ensayo.
    const r = await comando(c, `pnpm ${lineaShell(todos)}`, { cwd: desdeRaiz(), ...(o.filtro ? { filtro: o.filtro } : {}), tipo: (l) => (/BLOQUEADA|\[error\]/.test(l) ? "mal" : /advertencia/.test(l) ? "aviso" : undefined) });
    c.log(`(código de salida ${r.codigo})`, r.codigo === 0 ? "tenue" : "aviso");
    return r;
  }
  const r = await c.ejecutarComando("pnpm", todos, { cwd: desdeRaiz(), mostrar: `pnpm ${lineaShell(todos)}`, tablas: false, ...(o.filtro ? { filtro: o.filtro } : {}) });
  if (c.estudio.ensayo && o.simulado) {
    for (const l of o.simulado.salida) c.log(l);
    // En ensayo, un deploy simulado deja la API publicada en el servidor de ensayo (para los pasos siguientes).
    if (o.ensayoPublica && o.simulado.codigo === 0)
      await fetch(`${ENSAYO}/d0x/wso2/publicar`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: o.ensayoPublica }) }).catch(() => undefined);
    return o.simulado;
  }
  return r;
}
