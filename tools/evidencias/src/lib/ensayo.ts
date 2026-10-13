/**
 * Servidor de ensayo (V09): imita lo suficiente del laboratorio para iterar el motor de grabación sin él.
 * NADA de lo que sirve es evidencia: cada página lleva el rótulo ENSAYO, el video también, su pasos.json dice
 * ensayo:true y verificar.ts lo rechaza.
 *
 * Bajo un único puerto local (por defecto 5174) atiende, con el prefijo de cada origen del laboratorio
 * (ver ORIGENES_LAB en lab.ts; el navegador usa las URL reales y page.route() las desvía aquí):
 *   /keycloak/realms/nexo/…   inicio de sesión (formulario #username/#password/#kc-login), token y salida
 *   /api/v1/…                 API de la Consola: rutas de tráfico y despliegues canary/blue-green simulados
 *                             (pendiente → aprobado → sombra → 5/25/50/100 % → completado o revertido);
 *                             cualquier otra ruta responde vacío (GET []) o {ok:true}
 *   /gateway/…                gateway: responde JSON con x-backend-version según el despliegue en curso
 *   /chaos-v1/_chaos, /chaos-v2/_chaos   falla inyectable de cada versión del backend
 *   /wso2/…                   portales Publisher, Dev Portal y Admin (inicio de sesión y una lista de APIs) y
 *                             las REST API de aplicaciones y llaves que usa el generador de carga
 * Las páginas de la Consola de ensayo están en tools/evidencias/ensayo/consola (las sirve el estudio).
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { PAQUETE } from "./entorno.js";

const V1 = "http://concesiones-v1:7001";
const V2 = "http://concesiones-v2:7001";
const VERSION_DE: Record<string, string> = { [V1]: "1.0.0", [V2]: "1.1.0" };

export interface PasoRollout {
  kind: "sombra" | "peso";
  weight: number;
  requests: number;
  decision: "avanza" | "revierte" | "completa";
  errorRate: number;
}

export interface RolloutEnsayo {
  id: string;
  apiId: string;
  apiName: string;
  strategy: "canary" | "blue_green";
  candidateEndpoint: string;
  stableEndpoint: string;
  shadowSeconds: number;
  steps: number[];
  stepDurationSec: number;
  status: "pendiente_aprobacion" | "en_curso" | "completado" | "revertido" | "abortado";
  createdAt: string;
  approvedAt?: string;
  finishedAt?: string;
  currentWeight: number;
  stepsDone: PasoRollout[];
  rollbackReason?: string;
  requestedBy: string;
  approvedBy?: string;
  ensayo: true;
}

/** Estado simulado del despliegue `r` a los `seg` segundos de aprobado (función pura, se prueba aparte). */
export function avanzarRollout(
  r: RolloutEnsayo,
  seg: number,
  fallaCandidata: number,
  rps = 20,
): RolloutEnsayo {
  if (r.status !== "en_curso" && r.status !== "pendiente_aprobacion") return r;
  if (r.status === "pendiente_aprobacion") return r;
  const pasos: PasoRollout[] = [];
  let t = 0;
  if (r.strategy === "blue_green") {
    const fin = Math.max(2, r.stepDurationSec);
    if (seg < fin) return { ...r, currentWeight: 0, stepsDone: [] };
    return {
      ...r,
      status: "completado",
      currentWeight: 100,
      stepsDone: [
        { kind: "peso", weight: 100, requests: Math.round(fin * rps), decision: "completa", errorRate: 0 },
      ],
    };
  }
  if (r.shadowSeconds > 0) {
    const decide = fallaCandidata > 0 ? Math.min(r.shadowSeconds, 6) : r.shadowSeconds;
    if (seg < decide) return { ...r, currentWeight: 0, stepsDone: [] };
    const sombra: PasoRollout = {
      kind: "sombra",
      weight: 0,
      requests: Math.round(decide * rps),
      decision: fallaCandidata > 0.02 ? "revierte" : "avanza",
      errorRate: fallaCandidata,
    };
    pasos.push(sombra);
    if (sombra.decision === "revierte")
      return {
        ...r,
        status: "revertido",
        currentWeight: 0,
        stepsDone: pasos,
        rollbackReason: `sombra: tasa de error ${Math.round(fallaCandidata * 100)} % supera el umbral de 2 %`,
      };
    t = decide;
  }
  for (const peso of r.steps) {
    if (seg < t + r.stepDurationSec) return { ...r, currentWeight: peso, stepsDone: pasos };
    pasos.push({
      kind: "peso",
      weight: peso,
      requests: Math.round(r.stepDurationSec * rps * (peso / 100)),
      decision: peso === 100 ? "completa" : "avanza",
      errorRate: 0,
    });
    t += r.stepDurationSec;
  }
  return { ...r, status: "completado", currentWeight: 100, stepsDone: pasos };
}

const json = (res: ServerResponse, status: number, cuerpo: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-ensayo": "1",
    ...extra,
  });
  res.end(JSON.stringify(cuerpo));
};
const html = (res: ServerResponse, cuerpo: string, extra: Record<string, string> = {}) => {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-ensayo": "1",
    ...extra,
  });
  res.end(cuerpo);
};
const redirigir = (res: ServerResponse, a: string, extra: Record<string, string> = {}) => {
  res.writeHead(302, { location: a, "cache-control": "no-store", ...extra });
  res.end();
};
const esc = (t: string) =>
  t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function leer(req: IncomingMessage): Promise<string> {
  return new Promise((ok, mal) => {
    let s = "";
    req.on("data", (d: Buffer) => (s += d.toString()));
    req.on("end", () => ok(s));
    req.on("error", mal);
  });
}

function cuerpoComo(texto: string, tipo: string | undefined): Record<string, string> {
  if (tipo?.includes("application/json")) {
    try {
      return JSON.parse(texto) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(texto));
}

/** Token con forma de JWT (sin firma válida) para que la Consola de ensayo muestre la persona. */
export function tokenEnsayo(sujeto: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: sujeto, preferred_username: sujeto, ensayo: true, exp: Math.floor(Date.now() / 1000) + 3600 })}.ensayo`;
}

const PAGINA = (
  titulo: string,
  cuerpo: string,
  estilo = "",
) => `<!doctype html><html lang="es-CL"><head><meta charset="utf-8"><title>${esc(titulo)}</title>
<style>
  body { margin: 0; font: 15px/1.4 "Liberation Sans", "DejaVu Sans", Arial, sans-serif; color: #1f2933; background: #f2f4f7; }
  .ensayo { position: fixed; top: 0; right: 0; background: #c62828; color: #fff; font: bold 12px/1 Arial; letter-spacing: .14em; padding: 6px 12px; border-bottom-left-radius: 8px; z-index: 10; }
  label { display: block; margin: 14px 0 6px; font-size: 14px; color: #3e4c59; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 15px; border: 1px solid #b8c2cc; border-radius: 4px; }
  button { margin-top: 20px; width: 100%; padding: 11px; font-size: 15px; border: 0; border-radius: 4px; color: #fff; cursor: pointer; }
  ${estilo}
</style></head><body><div class="ensayo">ENSAYO</div>${cuerpo}</body></html>`;

export class ServidorEnsayo {
  private server?: Server;
  readonly puerto: number;
  private rollouts = new Map<string, RolloutEnsayo>();
  private aprobado = new Map<string, number>();
  private abortados = new Set<string>();
  private falla: Record<"v1" | "v2", number> = { v1: 0, v2: 0 };
  private fallaAlAprobar = new Map<string, number>();
  private ruta = {
    apiId: "api-concesiones",
    apiName: "Concesiones 1.0.0",
    stableUrl: V1,
    rolloutId: undefined as string | undefined,
  };
  private contador = 0;
  private llamadas = 0;
  private sesionesWso2 = new Set<string>();

  /** Puerto por defecto 5174; EVIDENCIAS_PUERTO_ENSAYO lo cambia (p. ej. para dos ensayos a la vez). */
  constructor(o: { puerto?: number } = {}) {
    const delEntorno = Number(process.env.EVIDENCIAS_PUERTO_ENSAYO);
    this.puerto =
      o.puerto ??
      (Number.isInteger(delEntorno) && delEntorno > 1024 && delEntorno < 65536 ? delEntorno : 5174);
  }

  get url(): string {
    return `http://localhost:${this.puerto}`;
  }

  async iniciar(): Promise<void> {
    this.server = createServer((req, res) => {
      this.atender(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(String(e instanceof Error ? e.message : e));
      });
    });
    await new Promise<void>((ok, mal) => {
      this.server!.once("error", mal);
      this.server!.listen(this.puerto, "127.0.0.1", () => ok());
    });
  }

  async detener(): Promise<void> {
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
    this.server?.closeAllConnections?.();
  }

  private rollout(id: string): RolloutEnsayo | undefined {
    const r = this.rollouts.get(id);
    if (!r) return undefined;
    if (this.abortados.has(id)) return r;
    const t = this.aprobado.get(id);
    if (t === undefined) return r;
    const actual = avanzarRollout(r, (Date.now() - t) / 1000, this.fallaAlAprobar.get(id) ?? 0);
    if (actual.status !== "en_curso" && r.status === "en_curso") {
      actual.finishedAt = new Date().toISOString();
      if (actual.status === "completado") this.ruta.stableUrl = actual.candidateEndpoint;
      this.ruta.rolloutId = undefined;
      this.rollouts.set(id, actual);
    }
    return actual;
  }

  private async atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const p = url.pathname;
    const metodo = req.method ?? "GET";
    if (p.startsWith("/keycloak/")) return this.keycloak(req, res, url, p.slice("/keycloak".length));
    if (p.startsWith("/api/v1/")) return this.api(req, res, metodo, p.slice("/api/v1".length));
    if (p.startsWith("/gateway/")) return this.gateway(res, p);
    if (p === "/chaos-v1/_chaos" || p === "/chaos-v2/_chaos") {
      const v = p.includes("v1") ? "v1" : "v2";
      if (metodo === "POST")
        this.falla[v] = Number(cuerpoComo(await leer(req), req.headers["content-type"]).failRate ?? 0);
      return json(res, 200, { failRate: this.falla[v], ensayo: true });
    }
    if (p.startsWith("/wso2/")) return this.wso2(req, res, url, p.slice("/wso2".length));
    if (p === "/" || p === "/salud")
      return json(res, 200, { servidor: "ensayo de evidencias", ensayo: true });
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`ensayo: ${p} no existe`);
  }

  // ── Keycloak ──────────────────────────────────────────────────────────────────────────────────────
  private async keycloak(req: IncomingMessage, res: ServerResponse, url: URL, p: string): Promise<void> {
    if (p.endsWith("/protocol/openid-connect/token")) {
      const b = cuerpoComo(await leer(req), req.headers["content-type"]);
      const auth = req.headers.authorization;
      const cliente = auth?.startsWith("Basic ")
        ? Buffer.from(auth.slice(6), "base64").toString().split(":")[0]
        : undefined;
      return json(res, 200, {
        access_token: tokenEnsayo(b.username ?? cliente ?? "aplicacion"),
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    if (p.endsWith("/protocol/openid-connect/auth")) {
      const destino = `/realms/nexo/login-actions/authenticate?${new URLSearchParams({ redirect_uri: url.searchParams.get("redirect_uri") ?? "", state: url.searchParams.get("state") ?? "" })}`;
      return html(
        res,
        PAGINA(
          "Iniciar sesión · nexo (ensayo)",
          `<div class="kc"><h1>NEXO</h1><form id="kc-form-login" method="post" action="${esc(destino)}">
             <h2>Inicia sesión en tu cuenta</h2>
             <label for="username">Usuario o correo</label><input id="username" name="username" autocomplete="off" autofocus>
             <label for="password">Contraseña</label><input id="password" name="password" type="password">
             <button id="kc-login" type="submit">Iniciar sesión</button></form></div>`,
          `.kc { max-width: 430px; margin: 9vh auto; } .kc h1 { text-align: center; letter-spacing: .3em; color: #39424e; font-weight: 300; }
           form { background: #fff; padding: 26px 34px 30px; border-top: 4px solid #0066cc; box-shadow: 0 2px 10px rgba(0,0,0,.12); }
           h2 { margin: 0 0 6px; font-size: 21px; text-align: center; font-weight: normal; } button { background: #0066cc; }`,
        ),
      );
    }
    if (p.endsWith("/login-actions/authenticate")) {
      const b = cuerpoComo(await leer(req), req.headers["content-type"]);
      const vuelta = url.searchParams.get("redirect_uri") ?? "http://localhost:5173/auth/callback";
      const sep = vuelta.includes("?") ? "&" : "?";
      return redirigir(
        res,
        `${vuelta}${sep}code=${encodeURIComponent(`ensayo.${b.username ?? "persona"}`)}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`,
      );
    }
    if (p.endsWith("/protocol/openid-connect/logout")) {
      const vuelta = url.searchParams.get("post_logout_redirect_uri") ?? "http://localhost:5173/";
      if (url.searchParams.get("confirmar") === "1") return redirigir(res, vuelta);
      return html(
        res,
        PAGINA(
          "Cerrar sesión (ensayo)",
          `<div style="max-width:420px;margin:12vh auto;background:#fff;padding:28px;box-shadow:0 2px 10px rgba(0,0,0,.12)"><h2>¿Cerrar la sesión?</h2>
           <form method="get"><input type="hidden" name="confirmar" value="1"><input type="hidden" name="post_logout_redirect_uri" value="${esc(vuelta)}">
           <button id="kc-logout" type="submit" style="background:#0066cc">Cerrar sesión</button></form></div>`,
        ),
      );
    }
    return json(res, 200, { realm: "nexo", ensayo: true });
  }

  // ── API de la Consola ─────────────────────────────────────────────────────────────────────────────
  private async api(req: IncomingMessage, res: ServerResponse, metodo: string, p: string): Promise<void> {
    const cuerpo =
      metodo === "GET" || metodo === "HEAD"
        ? {}
        : (cuerpoComo(await leer(req), req.headers["content-type"]) as Record<string, unknown>);
    const usuario = (() => {
      const t = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      try {
        return (
          (
            JSON.parse(Buffer.from(t.split(".")[1] ?? "", "base64url").toString()) as {
              preferred_username?: string;
            }
          ).preferred_username ?? "persona"
        );
      } catch {
        return "persona";
      }
    })();
    if (p === "/traffic-routes" && metodo === "GET") return json(res, 200, [{ ...this.ruta }]);
    if (p === "/rollouts" && metodo === "GET")
      return json(res, 200, [...this.rollouts.keys()].map((id) => this.rollout(id)).reverse());
    if (p === "/rollouts" && metodo === "POST") {
      if (this.ruta.rolloutId && this.rollout(this.ruta.rolloutId)?.status === "en_curso")
        return json(res, 409, { message: "ya hay un despliegue en curso (ensayo)" });
      const id = `ens-${String(++this.contador).padStart(3, "0")}`;
      const r: RolloutEnsayo = {
        id,
        apiId: String(cuerpo.apiId ?? this.ruta.apiId),
        apiName: this.ruta.apiName,
        strategy: cuerpo.strategy === "blue_green" ? "blue_green" : "canary",
        candidateEndpoint: String(cuerpo.candidateEndpoint ?? V2),
        stableEndpoint: this.ruta.stableUrl,
        shadowSeconds: Number(cuerpo.shadowSeconds ?? 0),
        steps: Array.isArray(cuerpo.steps) ? (cuerpo.steps as number[]) : [5, 25, 50, 100],
        stepDurationSec: Number(cuerpo.stepDurationSec ?? 10),
        status: "pendiente_aprobacion",
        createdAt: new Date().toISOString(),
        currentWeight: 0,
        stepsDone: [],
        requestedBy: usuario,
        ensayo: true,
      };
      this.rollouts.set(id, r);
      return json(res, 201, r);
    }
    const m = /^\/rollouts\/([^/]+)(\/(approve|abort))?$/.exec(p);
    if (m) {
      const id = m[1]!;
      const r = this.rollout(id);
      if (!r) return json(res, 404, { message: "no existe (ensayo)" });
      if (m[3] === "approve" && metodo === "POST") {
        if (r.status !== "pendiente_aprobacion") return json(res, 409, { message: "no está pendiente" });
        if (r.requestedBy === usuario)
          return json(res, 403, { message: "quien solicita no aprueba (regla de cuatro ojos)" });
        const aprobado: RolloutEnsayo = {
          ...r,
          status: "en_curso",
          approvedAt: new Date().toISOString(),
          approvedBy: usuario,
        };
        this.rollouts.set(id, aprobado);
        this.aprobado.set(id, Date.now());
        this.fallaAlAprobar.set(id, aprobado.candidateEndpoint === V2 ? this.falla.v2 : this.falla.v1);
        this.ruta.rolloutId = id;
        return json(res, 200, aprobado);
      }
      if (m[3] === "abort" && metodo === "POST") {
        const ab: RolloutEnsayo = {
          ...r,
          status: "abortado",
          finishedAt: new Date().toISOString(),
          rollbackReason: String(cuerpo.reason ?? "abortado"),
        };
        this.rollouts.set(id, ab);
        this.abortados.add(id);
        this.ruta.rolloutId = undefined;
        return json(res, 200, ab);
      }
      return json(res, 200, r);
    }
    if (p === "/ensayo/estado")
      return json(res, 200, { ensayo: true, llamadas: this.llamadas, ruta: this.ruta, falla: this.falla });
    if (metodo === "GET") return json(res, 200, []);
    if (metodo === "DELETE") {
      res.writeHead(204, { "x-ensayo": "1" }).end();
      return;
    }
    return json(res, 200, { ok: true, ensayo: true, ...cuerpo });
  }

  // ── Gateway ───────────────────────────────────────────────────────────────────────────────────────
  private gateway(res: ServerResponse, p: string): void {
    const n = this.llamadas++;
    const en = this.ruta.rolloutId ? this.rollout(this.ruta.rolloutId) : undefined;
    let endpoint = this.ruta.stableUrl;
    if (en?.status === "en_curso" && en.currentWeight > 0 && n % 100 < en.currentWeight)
      endpoint = en.candidateEndpoint;
    const version = VERSION_DE[endpoint] ?? "1.0.0";
    const falla = endpoint === V2 ? this.falla.v2 : this.falla.v1;
    if (falla > 0 && n % 100 < falla * 100)
      return json(res, 500, { error: "falla inyectada (ensayo)" }, { "x-backend-version": version });
    json(
      res,
      200,
      [
        { id: "C-0001", titular: "Operador de ensayo A", estado: "vigente", ruta: p },
        { id: "C-0002", titular: "Operador de ensayo B", estado: "vigente", ruta: p },
      ],
      { "x-backend-version": version },
    );
  }

  // ── Portales y REST de WSO2 ───────────────────────────────────────────────────────────────────────
  private async wso2(req: IncomingMessage, res: ServerResponse, url: URL, p: string): Promise<void> {
    if (p.startsWith("/api/am/devportal/v3/applications")) {
      if (/\/oauth-keys$/.test(p))
        return json(res, 200, {
          count: 1,
          list: [
            {
              keyManager: "Keycloak",
              keyType: "PRODUCTION",
              consumerKey: "ensayo-ck",
              consumerSecret: "ensayo-cs",
            },
          ],
        });
      return json(res, 200, {
        count: 2,
        list: [
          {
            applicationId: "app-ensayo-1",
            name: "OperadorDemo",
            throttlingPolicy: "Unlimited",
            status: "APPROVED",
          },
          {
            applicationId: "app-ensayo-2",
            name: "ReportesEnsayo",
            throttlingPolicy: "Unlimited",
            status: "APPROVED",
          },
        ],
      });
    }
    if (p.startsWith("/api/am/"))
      return json(res, 200, req.method === "GET" ? { count: 0, list: [] } : { ensayo: true });
    if (p.startsWith("/authenticationendpoint/login.do")) {
      const portal = url.searchParams.get("portal") ?? "publisher";
      return html(
        res,
        PAGINA(
          "WSO2 · inicio de sesión (ensayo)",
          `<div class="caja"><h2>Iniciar sesión</h2><form method="post" action="/commonauth?portal=${esc(portal)}">
            <label for="username">Usuario</label><input id="username" name="username" autocomplete="off">
            <label for="password">Contraseña</label><input id="password" name="password" type="password">
            <button type="submit">Continuar</button></form></div>`,
          `.caja { max-width: 420px; margin: 10vh auto; background: #fff; padding: 28px 32px; border-radius: 6px; box-shadow: 0 2px 12px rgba(0,0,0,.12); }
           h2 { margin: 0 0 4px; font-weight: 500; } button { background: #ff7300; }`,
        ),
      );
    }
    if (p === "/commonauth") {
      const b = cuerpoComo(await leer(req), req.headers["content-type"]);
      const sesion = `s${Date.now().toString(36)}`;
      this.sesionesWso2.add(sesion);
      const portal = url.searchParams.get("portal") ?? "publisher";
      return redirigir(res, `/${portal}/${portal === "admin" ? "" : "apis"}`, {
        "set-cookie": `ensayo_wso2=${sesion}; Path=/; HttpOnly`,
        "x-usuario": b.username ?? "",
      });
    }
    const m = /^\/(publisher|devportal|admin)(\/.*)?$/.exec(p);
    if (m) {
      const portal = m[1]!;
      const sesion = /ensayo_wso2=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
      const conectado = sesion !== undefined && this.sesionesWso2.has(sesion);
      if (!conectado && portal !== "devportal")
        return redirigir(res, `/authenticationendpoint/login.do?portal=${portal}`);
      return html(res, portalWso2(portal, conectado));
    }
    return json(res, 404, { message: "ensayo: no existe" });
  }
}

function portalWso2(portal: string, conectado: boolean): string {
  const nombre =
    { publisher: "Publisher", devportal: "Developer Portal", admin: "Admin Portal" }[portal] ?? portal;
  const filas = ["Concesiones", "Tarifas", "Espectro", "Reclamos", "Numeración"]
    .map(
      (n, i) =>
        `<tr><td>${n}</td><td>1.${i % 2}.0</td><td>${i === 3 ? "CREATED" : "PUBLISHED"}</td><td>/${n.toLowerCase()}</td></tr>`,
    )
    .join("");
  const acceso = conectado
    ? `<span>admin</span>`
    : `<a href="/authenticationendpoint/login.do?portal=${portal}" class="boton">REGISTRARSE</a>`;
  const plantilla = readFileSync(resolve(PAQUETE, "ensayo/wso2/portal.html"), "utf8");
  return plantilla
    .replaceAll("{{nombre}}", esc(nombre))
    .replace("{{acceso}}", acceso)
    .replace("{{filas}}", filas);
}
