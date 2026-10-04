#!/usr/bin/env node
/**
 * Herramienta de certificación Yago Nexo.
 *
 *   cert banco                                    valida banco.yaml y practico.yaml y muestra el resumen
 *   cert sortear  --semilla <texto> [--salida <dir>]
 *   cert corregir --examen <examen.json> --hoja <hoja.yaml> [--json]
 *   cert emitir   --examen <examen.json> --hoja <hoja.yaml> --fecha AAAA-MM-DD [--version-producto X.Y.Z]
 *                 [--salida <dir>] [--registro <registro.jsonl>]
 *   cert verificar (--pdf <certificado.pdf> | --codigo <código> --registro <registro.jsonl>) [--fecha AAAA-MM-DD]
 *
 * Con pnpm: pnpm --filter @nexo/certificacion cert <comando> [opciones]. Las rutas relativas se resuelven
 * desde la carpeta donde se ejecutó el comando.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import {
  BANCO_POR_OMISION,
  MODULOS_EXAMEN,
  PRACTICO_POR_OMISION,
  RAIZ_REPO,
  leerBanco,
  leerPractico,
  resumenBanco,
} from "./banco.js";
import {
  buscarEnRegistro,
  certificadoPdf,
  crearCertificado,
  documentoParaMostrar,
  leerCertificadoPdf,
  lineaRegistro,
  verificarCertificado,
  type Certificado,
} from "./certificado.js";
import { corregir, informe, validarHoja } from "./correccion.js";
import { examenMarkdown, plantillaHoja, sortearExamen, type Examen } from "./sorteo.js";

const CWD = process.env.INIT_CWD ?? process.cwd();
const ruta = (p: string) => resolve(CWD, p);
const nombreArchivo = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");
const hoy = () => new Date().toISOString().slice(0, 10);

class ErrorDeUso extends Error {}

function opciones<T extends Record<string, { type: "string" | "boolean" }>>(args: string[], defs: T) {
  return parseArgs({ args, options: defs, allowPositionals: false, strict: true }).values as {
    [K in keyof T]?: T[K]["type"] extends "string" ? string : boolean;
  };
}

function requerida(valor: string | undefined, nombre: string): string {
  if (!valor) throw new ErrorDeUso(`falta la opción --${nombre}`);
  return valor;
}

function versionPorOmision(): string {
  const release = join(RAIZ_REPO, "apps/site/src/data/release.json");
  if (!existsSync(release))
    throw new ErrorDeUso("indique --version-producto (no se encontró apps/site/src/data/release.json)");
  return (JSON.parse(readFileSync(release, "utf8")) as { version: string }).version;
}

function leerExamen(p: string): Examen {
  const ex = JSON.parse(readFileSync(ruta(p), "utf8")) as Examen;
  if (ex.formato !== "nexo-examen/1") throw new Error(`${p} no es un examen generado por esta herramienta`);
  return ex;
}

function cmdBanco(args: string[]) {
  const o = opciones(args, { banco: { type: "string" }, practico: { type: "string" } });
  const banco = leerBanco(o.banco ? ruta(o.banco) : BANCO_POR_OMISION);
  const practico = leerPractico(o.practico ? ruta(o.practico) : PRACTICO_POR_OMISION);
  const r = resumenBanco(banco);
  console.log(
    `Banco ${banco.version} (${banco.producto}) · ${banco.preguntas.length} preguntas · sha256 ${banco.sha256}`,
  );
  console.log("Módulo  baja  media  alta  total");
  for (const m of MODULOS_EXAMEN) {
    const x = r[m];
    console.log(
      `${m.padEnd(6)}  ${String(x.baja).padStart(4)}  ${String(x.media).padStart(5)}  ${String(x.alta).padStart(4)}  ${String(x.total).padStart(5)}`,
    );
  }
  const puntos = practico.tareas.reduce((s, t) => s + t.puntos, 0);
  console.log(
    `\nPráctico ${practico.version} · ${practico.tareas.length} tareas · ${puntos} puntos · ${practico.duracion_minutos} minutos`,
  );
  for (const t of practico.tareas)
    console.log(
      `  ${t.id} ${t.obligatoria ? "(obligatoria) " : ""}${t.titulo} · ${t.puntos} puntos · ${t.tiempo_minutos} min`,
    );
}

function cmdSortear(args: string[]) {
  const o = opciones(args, {
    semilla: { type: "string" },
    salida: { type: "string" },
    banco: { type: "string" },
  });
  const semilla = requerida(o.semilla, "semilla");
  const banco = leerBanco(o.banco ? ruta(o.banco) : BANCO_POR_OMISION);
  const practico = leerPractico();
  const ex = sortearExamen(banco, semilla);
  const dir = ruta(o.salida ?? ".");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `examen-${nombreArchivo(ex.id)}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(ex, null, 2)}\n`);
  writeFileSync(`${base}.md`, examenMarkdown(ex));
  writeFileSync(
    join(dir, `hoja-${nombreArchivo(ex.id)}.yaml`),
    plantillaHoja(
      ex,
      practico.tareas.map((t) => t.id),
    ),
  );
  console.log(
    `Examen ${ex.id}: ${ex.total} preguntas · ${MODULOS_EXAMEN.map((m) => `${m} ${ex.distribucion[m]}`).join(" · ")}`,
  );
  console.log(`  ${base}.json   (con la clave de respuestas: solo para el evaluador)`);
  console.log(`  ${base}.md     (enunciado para el participante, sin respuestas)`);
  console.log(`  ${join(dir, `hoja-${nombreArchivo(ex.id)}.yaml`)}   (hoja de respuestas en blanco)`);
}

function corregirDesdeArgs(o: { examen?: string; hoja?: string }) {
  const ex = leerExamen(requerida(o.examen, "examen"));
  const hojaRuta = requerida(o.hoja, "hoja");
  const hoja = validarHoja(parse(readFileSync(ruta(hojaRuta), "utf8")), hojaRuta);
  return corregir(ex, leerPractico(), hoja);
}

function cmdCorregir(args: string[]) {
  const o = opciones(args, {
    examen: { type: "string" },
    hoja: { type: "string" },
    json: { type: "boolean" },
  });
  const r = corregirDesdeArgs(o);
  console.log(o.json ? JSON.stringify(r, null, 2) : informe(r));
  if (!r.aprobado) process.exitCode = 2;
}

async function cmdEmitir(args: string[]) {
  const o = opciones(args, {
    examen: { type: "string" },
    hoja: { type: "string" },
    fecha: { type: "string" },
    "version-producto": { type: "string" },
    salida: { type: "string" },
    registro: { type: "string" },
  });
  const r = corregirDesdeArgs(o);
  if (!r.aprobado) {
    console.error(informe(r));
    console.error("\nNo se emite certificado: el resultado no está aprobado.");
    process.exitCode = 2;
    return;
  }
  const cert = crearCertificado(r, {
    fecha: requerida(o.fecha, "fecha"),
    versionProducto: o["version-producto"] ?? versionPorOmision(),
  });
  const dir = ruta(o.salida ?? ".");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `certificado-${cert.codigo}`);
  writeFileSync(`${base}.pdf`, await certificadoPdf(cert));
  writeFileSync(`${base}.json`, `${JSON.stringify(cert, null, 2)}\n`);
  if (o.registro) {
    const reg = ruta(o.registro);
    if (existsSync(reg) && buscarEnRegistro(readFileSync(reg, "utf8"), cert.codigo))
      throw new Error(`el código ${cert.codigo} ya está en el registro ${o.registro}`);
    appendFileSync(reg, lineaRegistro(cert));
  }
  console.log(`Certificado emitido para ${cert.nombre} (${documentoParaMostrar(cert.documento)})`);
  console.log(`  Código: ${cert.codigo}`);
  console.log(`  Hash SHA-256: ${cert.hash}`);
  console.log(`  Vigente hasta: ${cert.vigenteHasta} (Yago Nexo ${cert.versionMayor}.x)`);
  console.log(`  ${base}.pdf`);
  console.log(`  ${base}.json`);
  if (o.registro) console.log(`  Registrado en ${ruta(o.registro)}`);
}

async function cmdVerificar(args: string[]) {
  const o = opciones(args, {
    pdf: { type: "string" },
    codigo: { type: "string" },
    registro: { type: "string" },
    fecha: { type: "string" },
  });
  let cert: Certificado | undefined;
  let enRegistro: boolean | undefined;
  if (o.pdf) {
    cert = await leerCertificadoPdf(new Uint8Array(readFileSync(ruta(o.pdf))));
    if (o.registro) {
      const reg = buscarEnRegistro(readFileSync(ruta(o.registro), "utf8"), cert.codigo);
      enRegistro = !!reg && reg.hash === cert.hash;
    }
  } else if (o.codigo) {
    cert = buscarEnRegistro(readFileSync(ruta(requerida(o.registro, "registro")), "utf8"), o.codigo);
    if (!cert) {
      console.log(`El código ${o.codigo.toUpperCase()} NO está en el registro de certificados emitidos.`);
      process.exitCode = 2;
      return;
    }
    enRegistro = true;
  } else throw new ErrorDeUso("indique --pdf <archivo> o --codigo <código> con --registro <archivo>");

  const v = verificarCertificado(cert, o.fecha ?? hoy());
  console.log(`Certificado ${cert.codigo}`);
  console.log(`  ${cert.programa}`);
  console.log(`  ${cert.nombre} · ${documentoParaMostrar(cert.documento)}`);
  console.log(
    `  Emitido el ${cert.fecha} · vigente hasta el ${cert.vigenteHasta} · Yago Nexo ${cert.versionProducto}`,
  );
  console.log(`  Hash SHA-256: ${cert.hash}`);
  console.log(
    `  Integridad: ${v.integro ? "correcta (el código y el hash corresponden a los datos)" : `FALLA: ${v.motivo}`}`,
  );
  if (v.integro) console.log(`  Vigencia: ${v.vigente ? "vigente" : `no vigente (${v.motivo})`}`);
  if (enRegistro !== undefined)
    console.log(`  Registro de Yago: ${enRegistro ? "coincide" : "NO coincide o no está registrado"}`);
  if (!v.integro || !v.vigente || enRegistro === false) process.exitCode = 2;
}

const AYUDA = `Herramienta de certificación Yago Nexo

Comandos:
  banco      Valida banco.yaml y practico.yaml y muestra cuántas preguntas hay por módulo
  sortear    --semilla <texto> [--salida <dir>]
             Sortea un examen de 40 preguntas equilibrado por módulo (M0 a M6). Misma semilla, mismo examen.
  corregir   --examen <examen.json> --hoja <hoja.yaml> [--json]
             Corrige: aprueba con 70 % o más en el teórico y el práctico aprobado (código de salida 2 si reprueba).
  emitir     --examen <examen.json> --hoja <hoja.yaml> --fecha AAAA-MM-DD [--version-producto X.Y.Z]
             [--salida <dir>] [--registro <registro.jsonl>]
             Corrige y, si aprueba, genera el certificado en PDF y JSON y lo agrega al registro.
  verificar  --pdf <certificado.pdf> [--registro <registro.jsonl>] [--fecha AAAA-MM-DD]
             --codigo <código> --registro <registro.jsonl> [--fecha AAAA-MM-DD]
             Recalcula código y hash, y revisa la vigencia (2 años, para la versión mayor certificada).`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const [comando, ...resto] = argv;
  switch (comando) {
    case "banco":
      return cmdBanco(resto);
    case "sortear":
      return cmdSortear(resto);
    case "corregir":
      return cmdCorregir(resto);
    case "emitir":
      return cmdEmitir(resto);
    case "verificar":
      return cmdVerificar(resto);
    case undefined:
    case "ayuda":
    case "--help":
    case "-h":
      console.log(AYUDA);
      return;
    default:
      throw new ErrorDeUso(`comando desconocido: ${comando}`);
  }
}

main().catch((e: unknown) => {
  if (e instanceof ErrorDeUso) {
    console.error(`ERROR: ${e.message}\n\n${AYUDA}`);
  } else {
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exitCode = 1;
});
