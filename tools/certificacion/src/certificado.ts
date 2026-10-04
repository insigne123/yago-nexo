import { createHash } from "node:crypto";
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import type { Resultado } from "./correccion.js";

export const PROGRAMA = "Certificación Yago Nexo — Administrador/Integrador de la plataforma";
export const EMISOR = "Sociedad de Inversiones Yago SpA";
/** Casilla para confirmar un certificado (la misma de soporte del sitio de Nexo). */
export const CONTACTO_VERIFICACION = "soporte@yago.cl"; // TODO(Yago): confirmar casilla
/** Años de vigencia del certificado, para la versión mayor certificada. */
export const ANOS_VIGENCIA = 2;
/** Clave del diccionario de información del PDF donde viajan los datos firmados por el hash. */
const CLAVE_PDF = "NexoCertificado";

export interface DatosCertificado {
  programa: string;
  emisor: string;
  nombre: string;
  /** Documento de identidad normalizado (RUT sin puntos con guion y dígito verificador en mayúscula). */
  documento: string;
  /** Fecha de emisión, AAAA-MM-DD. */
  fecha: string;
  /** Último día de vigencia, AAAA-MM-DD (fecha de emisión más dos años). */
  vigenteHasta: string;
  versionProducto: string;
  versionMayor: number;
  examen: string;
  notaTeorica: number;
  practico: "aprobado";
}

export interface Certificado extends DatosCertificado {
  codigo: string;
  hash: string;
}

// ------------------------------------------------------------------ documento de identidad

const RE_RUT = /^(\d{1,2}(?:\.?\d{3}){2})-?([\dkK])$/;

function dvRut(cuerpo: string): string {
  let suma = 0;
  let mult = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * mult;
    mult = mult === 7 ? 2 : mult + 1;
  }
  const r = 11 - (suma % 11);
  return r === 11 ? "0" : r === 10 ? "K" : String(r);
}

/**
 * Normaliza el documento de identidad. Un RUT se valida con su dígito verificador y queda como
 * 12345678-5; otro documento (por ejemplo, un pasaporte) se acepta con letras, dígitos y guiones.
 */
export function normalizarDocumento(documento: string): string {
  const limpio = documento.trim().replace(/\s+/g, "");
  const m = RE_RUT.exec(limpio);
  if (m) {
    const cuerpo = m[1]!.replace(/\./g, "");
    const dv = m[2]!.toUpperCase();
    if (dvRut(cuerpo) !== dv) throw new Error(`el RUT ${documento} no es válido (dígito verificador)`);
    return `${cuerpo}-${dv}`;
  }
  const otro = limpio.toUpperCase();
  if (!/^[A-Z0-9-]{5,20}$/.test(otro))
    throw new Error(
      `documento de identidad no válido: "${documento}" (use un RUT o un documento de 5 a 20 letras o dígitos)`,
    );
  return otro;
}

/** RUT con puntos para mostrar (12.345.678-5); otros documentos tal cual. */
export function documentoParaMostrar(documento: string): string {
  const m = /^(\d{7,8})-([\dK])$/.exec(documento);
  if (!m) return documento;
  return `${m[1]!.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${m[2]}`;
}

// ------------------------------------------------------------------ fechas

function validarFecha(fecha: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error(`fecha "${fecha}" no tiene la forma AAAA-MM-DD`);
  const d = new Date(`${fecha}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== fecha)
    throw new Error(`fecha "${fecha}" no existe`);
  return d;
}

/** Misma fecha N años después; un 29 de febrero pasa al 28 si el año de destino no es bisiesto. */
export function sumarAnos(fecha: string, anos: number): string {
  const d = validarFecha(fecha);
  const y = d.getUTCFullYear() + anos;
  const m = d.getUTCMonth();
  const ultimo = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const dia = Math.min(d.getUTCDate(), ultimo);
  return new Date(Date.UTC(y, m, dia)).toISOString().slice(0, 10);
}

const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
export function fechaLarga(fecha: string): string {
  const d = validarFecha(fecha);
  return `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

// ------------------------------------------------------------------ código y hash

/** JSON canónico: claves en orden, sin espacios y sin campos vacíos (igual criterio que la auditoría de Nexo). */
export function canonico(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(",")}]`;
  const entradas = Object.entries(valor as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${canonico(v)}`).join(",")}}`;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: sin I, L, O ni U

function base32(bytes: Uint8Array, largo: number): string {
  let bits = 0;
  let valor = 0;
  let out = "";
  for (const b of bytes) {
    valor = (valor << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < largo) {
      out += BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
    valor &= (1 << bits) - 1;
    if (out.length >= largo) break;
  }
  return out;
}

/**
 * Código del certificado, p. ej. YNX-1-2026-7K2Q-M9TA: versión mayor, año y 40 bits derivados de quién,
 * cuándo, qué versión y qué examen. Es determinista: los mismos datos dan siempre el mismo código.
 */
export function codigoCertificado(
  d: Pick<DatosCertificado, "documento" | "fecha" | "versionProducto" | "versionMayor" | "examen">,
): string {
  const sufijo = base32(
    sha256(["nexo-cert", d.documento, d.fecha, d.versionProducto, d.examen].join("|")),
    8,
  );
  return `YNX-${d.versionMayor}-${d.fecha.slice(0, 4)}-${sufijo.slice(0, 4)}-${sufijo.slice(4)}`;
}

/** Hash de verificación: SHA-256 del certificado completo (datos y código) en forma canónica. */
export function hashCertificado(c: DatosCertificado & { codigo: string }): string {
  const {
    programa,
    emisor,
    nombre,
    documento,
    fecha,
    vigenteHasta,
    versionProducto,
    versionMayor,
    examen,
    notaTeorica,
    practico,
    codigo,
  } = c;
  const datos = {
    programa,
    emisor,
    nombre,
    documento,
    fecha,
    vigenteHasta,
    versionProducto,
    versionMayor,
    examen,
    notaTeorica,
    practico,
    codigo,
  };
  return createHash("sha256").update(canonico(datos), "utf8").digest("hex");
}

export interface OpcionesCertificado {
  fecha: string;
  versionProducto: string;
}

/** Arma el certificado de un resultado aprobado. Rechaza un resultado reprobado. */
export function crearCertificado(r: Resultado, o: OpcionesCertificado): Certificado {
  if (!r.aprobado) throw new Error("el resultado no está aprobado: no corresponde emitir certificado");
  validarFecha(o.fecha);
  const m = /^(\d+)\.\d+\.\d+$/.exec(o.versionProducto);
  if (!m) throw new Error(`versión del producto "${o.versionProducto}" no es MAYOR.MENOR.PARCHE`);
  const nombre = r.participante.nombre.trim().replace(/\s+/g, " ");
  const datos: DatosCertificado = {
    programa: PROGRAMA,
    emisor: EMISOR,
    nombre,
    documento: normalizarDocumento(r.participante.documento),
    fecha: o.fecha,
    vigenteHasta: sumarAnos(o.fecha, ANOS_VIGENCIA),
    versionProducto: o.versionProducto,
    versionMayor: Number(m[1]),
    examen: r.examen,
    notaTeorica: r.teorico.porcentaje,
    practico: "aprobado",
  };
  const codigo = codigoCertificado(datos);
  return { ...datos, codigo, hash: hashCertificado({ ...datos, codigo }) };
}

export interface Verificacion {
  integro: boolean;
  vigente: boolean;
  motivo?: string;
  certificado: Certificado;
}

/** Comprueba que el código y el hash correspondan a los datos, y la vigencia a una fecha dada. */
export function verificarCertificado(c: Certificado, fechaConsulta: string): Verificacion {
  validarFecha(fechaConsulta);
  if (codigoCertificado(c) !== c.codigo)
    return { integro: false, vigente: false, motivo: "el código no corresponde a los datos", certificado: c };
  if (hashCertificado(c) !== c.hash)
    return {
      integro: false,
      vigente: false,
      motivo: "el hash no corresponde a los datos (certificado alterado)",
      certificado: c,
    };
  if (fechaConsulta < c.fecha)
    return {
      integro: true,
      vigente: false,
      motivo: "la fecha de consulta es anterior a la emisión",
      certificado: c,
    };
  if (fechaConsulta > c.vigenteHasta)
    return { integro: true, vigente: false, motivo: `venció el ${c.vigenteHasta}`, certificado: c };
  return { integro: true, vigente: true, certificado: c };
}

// ------------------------------------------------------------------ PDF

/** Lo que las fuentes estándar del PDF (WinAnsi) no pueden dibujar se reemplaza (las tildes y la ñ sí están). */
function ansi(t: string): string {
  return t
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x20-\x7E\xA0-\xFF—–•·]/g, "?");
}

const A4_HORIZONTAL: [number, number] = [841.89, 595.28];
const AZUL = rgb(0.06, 0.25, 0.45);
const TINTA = rgb(0.13, 0.15, 0.2);
const GRIS = rgb(0.4, 0.43, 0.48);

function centrado(page: PDFPage, texto: string, y: number, font: PDFFont, size: number, color = TINTA) {
  const t = ansi(texto);
  const w = font.widthOfTextAtSize(t, size);
  page.drawText(t, { x: (page.getWidth() - w) / 2, y, size, font, color });
}

/** Ajusta el tamaño de letra para que un texto quepa en el ancho dado. */
function tamanoQueCabe(font: PDFFont, texto: string, maximo: number, ancho: number): number {
  let size = maximo;
  while (size > 10 && font.widthOfTextAtSize(ansi(texto), size) > ancho) size -= 1;
  return size;
}

/** Genera el PDF del certificado (una página A4 horizontal). Mismos datos → mismo archivo. */
export async function certificadoPdf(c: Certificado): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fechaPdf = new Date(`${c.fecha}T12:00:00Z`);
  doc.setTitle(PROGRAMA);
  doc.setSubject(`Certificado ${c.codigo}`);
  doc.setAuthor(EMISOR);
  doc.setCreator("Yago Nexo · herramienta de certificación");
  doc.setProducer("Yago Nexo");
  doc.setKeywords(["Yago Nexo", "certificación", c.codigo]);
  doc.setLanguage("es-CL");
  doc.setCreationDate(fechaPdf);
  doc.setModificationDate(fechaPdf);
  // Los datos del certificado viajan dentro del PDF para poder recalcular el hash sin otra fuente.
  const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
  info.set(PDFName.of(CLAVE_PDF), PDFHexString.fromText(JSON.stringify(c)));

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const monoNegrita = await doc.embedFont(StandardFonts.CourierBold);
  const page = doc.addPage(A4_HORIZONTAL);
  const [W, H] = A4_HORIZONTAL;

  page.drawRectangle({ x: 24, y: 24, width: W - 48, height: H - 48, borderColor: AZUL, borderWidth: 2 });
  page.drawRectangle({ x: 32, y: 32, width: W - 64, height: H - 64, borderColor: AZUL, borderWidth: 0.5 });

  centrado(page, "YAGO NEXO", H - 86, negrita, 13, AZUL);
  centrado(page, EMISOR, H - 104, regular, 10, GRIS);
  centrado(page, "Certificación Yago Nexo", H - 152, negrita, 30, AZUL);
  centrado(page, "Administrador/Integrador de la plataforma", H - 180, regular, 18, AZUL);

  centrado(page, "Se certifica que", H - 228, regular, 12, GRIS);
  centrado(page, c.nombre, H - 262, negrita, tamanoQueCabe(negrita, c.nombre, 26, W - 140), TINTA);
  centrado(page, `Documento de identidad: ${documentoParaMostrar(c.documento)}`, H - 284, regular, 11, TINTA);
  centrado(
    page,
    `aprobó el examen teórico (${c.notaTeorica} % de respuestas correctas) y la evaluación práctica en laboratorio,`,
    H - 314,
    regular,
    11.5,
  );
  centrado(
    page,
    `que acreditan competencias para administrar e integrar la plataforma Yago Nexo ${c.versionMayor}.x.`,
    H - 330,
    regular,
    11.5,
  );

  const filas: Array<[string, string]> = [
    ["Versión del producto", `Yago Nexo ${c.versionProducto} (versión mayor ${c.versionMayor})`],
    ["Fecha de emisión", fechaLarga(c.fecha)],
    ["Vigente hasta", `${fechaLarga(c.vigenteHasta)}, para Yago Nexo ${c.versionMayor}.x`],
    ["Examen", c.examen],
  ];
  let y = H - 372;
  const xEtiqueta = 168;
  const xValor = 362;
  for (const [etiqueta, valor] of filas) {
    page.drawText(ansi(etiqueta), { x: xEtiqueta, y, size: 10.5, font: negrita, color: GRIS });
    page.drawText(ansi(valor), { x: xValor, y, size: 10.5, font: regular, color: TINTA });
    y -= 17;
  }

  y -= 10;
  page.drawText("Código del certificado", { x: xEtiqueta, y, size: 10.5, font: negrita, color: GRIS });
  page.drawText(c.codigo, { x: xValor, y: y - 1, size: 14, font: monoNegrita, color: AZUL });
  y -= 20;
  page.drawText(ansi("Hash de verificación (SHA-256)"), {
    x: xEtiqueta,
    y,
    size: 10.5,
    font: negrita,
    color: GRIS,
  });
  page.drawText(c.hash, { x: xValor, y, size: 8.2, font: mono, color: TINTA });

  page.drawLine({ start: { x: 120, y: 96 }, end: { x: 330, y: 96 }, thickness: 0.6, color: GRIS });
  page.drawText(ansi("Responsable de certificación · Yago"), {
    x: 130,
    y: 82,
    size: 9,
    font: regular,
    color: GRIS,
  });
  const pie = [
    `Emitido por ${EMISOR}, fabricante de la distribución Yago Nexo.`,
    `Para confirmar este certificado, escriba a ${CONTACTO_VERIFICACION} indicando el código.`,
    "La herramienta de certificación de Yago Nexo recalcula el hash con los datos incluidos en este archivo.",
  ];
  pie.forEach((t, i) =>
    page.drawText(ansi(t), { x: 390, y: 96 - i * 12, size: 8, font: regular, color: GRIS }),
  );

  return doc.save({ useObjectStreams: false });
}

/** Lee los datos del certificado incluidos en un PDF emitido por esta herramienta. */
export async function leerCertificadoPdf(bytes: Uint8Array): Promise<Certificado> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const infoRef = doc.context.trailerInfo.Info;
  if (!infoRef) throw new Error("el PDF no tiene diccionario de información");
  const valor = doc.context.lookup(infoRef, PDFDict).lookup(PDFName.of(CLAVE_PDF));
  if (!(valor instanceof PDFHexString || valor instanceof PDFString))
    throw new Error("el PDF no contiene los datos de un certificado Yago Nexo");
  return JSON.parse(valor.decodeText()) as Certificado;
}

/** Línea del registro de certificados emitidos (JSON Lines), que conserva Yago. */
export function lineaRegistro(c: Certificado): string {
  return `${JSON.stringify(c)}\n`;
}

export function buscarEnRegistro(contenido: string, codigo: string): Certificado | undefined {
  const buscado = codigo.trim().toUpperCase();
  for (const linea of contenido.split(/\r?\n/)) {
    if (!linea.trim()) continue;
    const c = JSON.parse(linea) as Certificado;
    if (c.codigo === buscado) return c;
  }
  return undefined;
}
