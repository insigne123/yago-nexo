/**
 * Registro de evidencia de una ejecución de prueba de aceptación, con los campos exigidos: ambiente, versión,
 * topología, recursos, configuración, datos, condiciones previas, pasos, duración, carga, resultado esperado,
 * tolerancia, ejecutor, testigo, aprobador y evidencia; más campos de control y de resultado.
 */
import { createHash } from "node:crypto";
import type { Caso } from "./casos.js";

export interface Entorno {
  ambiente: string;
  version: string;
  commit: string;
  sbomSha256: string | null;
  configuracionSha256: string;
  host: string;
  vcpu: number;
  ramGB: number;
  /** Contenedores en ejecución: nombre → imagen. */
  contenedores: Record<string, string>;
}

export interface Ejecucion {
  inicio: Date;
  fin: Date;
  codigoSalida: number;
  salida: string;
}

export interface Registro {
  numero: string;
  caso: string;
  requisitos: string[];
  titulo: string;
  hito: string;
  ejecucionN: number;
  ambiente: string;
  version: string;
  topologia: string[];
  recursos: string;
  configuracion: string;
  datos: string;
  condicionesPrevias: string;
  pasos: string[];
  comando: string;
  duracion: { inicio: string; fin: string; segundos: number };
  carga: string;
  resultadoEsperado: string;
  tolerancia: string;
  ejecutor: string;
  testigo: string;
  aprobador: string;
  evidencia: { archivo: string; sha256: string }[];
  resultadoObtenido: string;
  estado: "Aprobada" | "Rechazada";
  defectos: string;
}

export const sha256 = (dato: string | Uint8Array): string => createHash("sha256").update(dato).digest("hex");

// Secuencias de color ANSI (ESC [ … m) que dejan las herramientas en su salida.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Últimas líneas útiles de la salida, para el campo «resultado obtenido» (la salida completa va como evidencia). */
export function resumenSalida(salida: string, lineas = 6): string {
  const limpias = salida
    .split("\n")
    .map((l) => l.replace(ANSI, "").trimEnd())
    .filter((l) => l.trim() && !/^[│├└┌─┬┴┼┐┘┤\s]+$/.test(l) && !l.startsWith(">") && !/ERR_PNPM|^\s*at /.test(l));
  return limpias.slice(-lineas).join("\n");
}

/** Topología del caso: los componentes que participan, con la imagen que corre cada uno si está en ejecución. */
export function topologia(caso: Caso, contenedores: Record<string, string>): string[] {
  return caso.componentes.map((c) => {
    const nombre = Object.keys(contenedores).find((n) => n === `nexo-lab-${c}-1` || n === c);
    return nombre ? `${c} (${contenedores[nombre]})` : `${c} (no está en ejecución)`;
  });
}

export function construirRegistro(o: {
  caso: Caso;
  hito: string;
  ejecucionN: number;
  correlativo: number;
  entorno: Entorno;
  ejecucion: Ejecucion;
  evidencia: { archivo: string; sha256: string }[];
  ejecutor: string;
  testigo?: string;
  aprobador?: string;
}): Registro {
  const { caso, entorno: e, ejecucion: x } = o;
  const aprobada = x.codigoSalida === 0;
  return {
    numero: `${o.hito}-${caso.id}-${String(o.ejecucionN).padStart(2, "0")}`,
    caso: caso.id,
    requisitos: caso.requisitos,
    titulo: caso.titulo,
    hito: o.hito,
    ejecucionN: o.ejecucionN,
    ambiente: e.ambiente,
    version: `${e.version} (commit ${e.commit}${e.sbomSha256 ? `, SBOM sha256 ${e.sbomSha256.slice(0, 16)}…` : ""})`,
    topologia: topologia(caso, e.contenedores),
    recursos: `${e.host}: ${e.vcpu} vCPU, ${e.ramGB} GB RAM (compartidos por todo el laboratorio)`,
    configuracion: `Configuración del laboratorio (deploy/compose) con huella sha256 ${e.configuracionSha256.slice(0, 16)}…`,
    datos: caso.datos,
    condicionesPrevias: caso.condicionesPrevias,
    pasos: caso.pasos,
    comando: caso.comando,
    duracion: { inicio: x.inicio.toISOString(), fin: x.fin.toISOString(), segundos: Math.round((x.fin.getTime() - x.inicio.getTime()) / 100) / 10 },
    carga: caso.carga,
    resultadoEsperado: caso.resultadoEsperado,
    tolerancia: caso.tolerancia,
    ejecutor: o.ejecutor,
    testigo: o.testigo ?? "Pendiente de firma",
    aprobador: o.aprobador ?? "Pendiente de firma",
    evidencia: o.evidencia,
    resultadoObtenido: resumenSalida(x.salida) || "(sin salida)",
    estado: aprobada ? "Aprobada" : "Rechazada",
    defectos: aprobada ? "Ninguno" : `La verificación terminó con código ${x.codigoSalida}; ver la salida completa en la evidencia.`,
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Filas (campo, valor) en el orden de las Bases, para el registro legible. */
export function filas(r: Registro): [string, string][] {
  return [
    ["N° de registro", r.numero],
    ["Caso y requisitos", `${r.caso} · ${r.requisitos.join(", ")}`],
    ["Hito y ejecución", `${r.hito} · ejecución ${r.ejecucionN}`],
    ["Ambiente", r.ambiente],
    ["Versión", r.version],
    ["Topología", r.topologia.join("\n")],
    ["Recursos", r.recursos],
    ["Configuración", r.configuracion],
    ["Datos", r.datos],
    ["Condiciones previas", r.condicionesPrevias],
    ["Pasos", [...r.pasos.map((p, i) => `${i + 1}. ${p}`), `Comando: ${r.comando}`].join("\n")],
    ["Duración", `${r.duracion.inicio} → ${r.duracion.fin} (${r.duracion.segundos} s)`],
    ["Carga", r.carga],
    ["Resultado esperado", r.resultadoEsperado],
    ["Tolerancia", r.tolerancia],
    ["Ejecutor", r.ejecutor],
    ["Testigo", r.testigo],
    ["Aprobador", r.aprobador],
    ["Evidencia", r.evidencia.map((v) => `${v.archivo} · sha256 ${v.sha256}`).join("\n")],
    ["Resultado obtenido", r.resultadoObtenido],
    ["Estado", r.estado],
    ["Defectos", r.defectos],
  ];
}

export function html(r: Registro): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Registro ${esc(r.numero)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;margin:24px;color:#1f2937}h1{color:#1F3864;font-size:15pt}table{border-collapse:collapse;width:100%}
th{background:#1F3864;color:#fff;text-align:left;width:24%}th,td{border:1px solid #BFC9D6;padding:5px 7px;vertical-align:top;white-space:pre-wrap}
.ok{color:#166534;font-weight:bold}.mal{color:#9a3412;font-weight:bold}</style></head><body>
<h1>Registro de prueba de aceptación ${esc(r.numero)}</h1><p>${esc(r.titulo)}</p><table>
${filas(r)
  .map(([c, v]) => `<tr><th>${esc(c)}</th><td${c === "Estado" ? ` class="${r.estado === "Aprobada" ? "ok" : "mal"}"` : ""}>${esc(v)}</td></tr>`)
  .join("\n")}
</table><p>Firma del ejecutor: ____________________ &nbsp; Firma del testigo: ____________________ &nbsp; Firma del aprobador: ____________________</p></body></html>`;
}

export function markdown(r: Registro): string {
  const celda = (v: string) => v.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  return [`# Registro ${r.numero}`, "", r.titulo, "", "| Campo | Valor |", "| --- | --- |", ...filas(r).map(([c, v]) => `| ${c} | ${celda(v)} |`), ""].join("\n");
}
