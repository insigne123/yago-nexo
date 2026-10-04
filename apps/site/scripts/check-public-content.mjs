// Control posterior al build (postbuild) sobre apps/site/build:
//  1. Ningún texto no publicable (ver FORBIDDEN en lib.mjs) en HTML, XML, JSON, YAML o texto.
//  2. Ninguna página ni hoja de estilo carga recursos externos (fuentes, CDN, scripts, analítica):
//     el sitio debe funcionar sin conexión y no rastrea a sus visitantes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fail, findForbidden, fromSite } from "./lib.mjs";

const SCRIPT = "check-public-content.mjs";
const BUILD = fromSite("build");
const SITIO = "yago-nexo.web.app";
if (!existsSync(BUILD)) fail(SCRIPT, `no existe ${BUILD}; ejecute primero el build`);

const TEXTO = new Set([".html", ".xml", ".json", ".yaml", ".yml", ".txt", ".xsl", ".svg"]);
const EXTERNOS_HTML = [
  { re: /<script\b[^>]*\bsrc=["']?(?:https?:)?\/\//gi, motivo: "script externo" },
  {
    re: new RegExp(
      String.raw`<link\b(?=[^>]*\brel=["']?(?:stylesheet|preload|preconnect|dns-prefetch|modulepreload|icon|manifest)\b)[^>]*\bhref=["']?(?:https?:)?\/\/(?!${SITIO.replace(/\./g, "\\.")})`,
      "gi",
    ),
    motivo: "recurso externo en <link>",
  },
  {
    re: /<(?:img|iframe|video|audio|source|embed)\b[^>]*\bsrc=["']?(?:https?:)?\/\//gi,
    motivo: "contenido embebido externo",
  },
  {
    re: /googletagmanager|google-analytics|gtag\(|fonts\.googleapis|fonts\.gstatic/gi,
    motivo: "analítica o fuentes externas",
  },
];
const EXTERNOS_CSS = [
  { re: /(?:@import\s+(?:url\()?|url\()\s*["']?(?:https?:)?\/\//gi, motivo: "recurso externo en CSS" },
];

function* archivos(dir) {
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) yield* archivos(ruta);
    else yield ruta;
  }
}

const problemas = [];
let revisados = 0;
for (const ruta of archivos(BUILD)) {
  const ext = extname(ruta).toLowerCase();
  const esCss = ext === ".css";
  if (!TEXTO.has(ext) && !esCss) continue;
  revisados++;
  const contenido = readFileSync(ruta, "utf8");
  const donde = relative(BUILD, ruta);
  if (!esCss) {
    for (const h of findForbidden(contenido))
      problemas.push(`${donde}: "${h.match}" (${h.motivo}) …${h.snippet}…`);
  }
  const reglas = esCss ? EXTERNOS_CSS : ext === ".html" ? EXTERNOS_HTML : [];
  for (const { re, motivo } of reglas) {
    for (const m of contenido.matchAll(re)) problemas.push(`${donde}: ${motivo}: ${m[0].slice(0, 120)}`);
  }
}

if (problemas.length > 0) {
  fail(
    SCRIPT,
    `el build no es publicable (${problemas.length} problemas):\n  - ${problemas.slice(0, 50).join("\n  - ")}`,
  );
}
console.log(`[${SCRIPT}] ${revisados} archivos revisados: sin texto no publicable ni recursos externos`);
