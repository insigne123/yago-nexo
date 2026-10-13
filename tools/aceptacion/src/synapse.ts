/**
 * Simulador mínimo de la mediación de Synapse (Micro Integrator) para pruebas de contrato sobre los artefactos
 * versionados en wso2/mi/artifacts. No reemplaza al integrador: ejecuta, con la misma semántica, el subconjunto de
 * mediadores y de XPath 1.0 que usan las secuencias del consumidor (property, header, log, filter, switch,
 * sequence, call, enrich, payloadFactory, drop) y registra a qué endpoints se llama y con qué encabezados.
 * Así una prueba unitaria comprueba la decisión de reintento o de cola de fallidos que toma la configuración real.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Nodo {
  nombre: string;
  atributos: Record<string, string>;
  hijos: Nodo[];
}

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodificar = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTIDADES[e]!);

/** Analizador XML suficiente para los artefactos de Synapse (elementos, atributos, comentarios y CDATA). */
export function analizarXml(xml: string): Nodo {
  let i = 0;
  const raiz: Nodo = { nombre: "#documento", atributos: {}, hijos: [] };
  const pila: Nodo[] = [raiz];
  while (i < xml.length) {
    if (xml.startsWith("<!--", i)) {
      i = xml.indexOf("-->", i) + 3;
    } else if (xml.startsWith("<![CDATA[", i)) {
      i = xml.indexOf("]]>", i) + 3;
    } else if (xml.startsWith("<?", i)) {
      i = xml.indexOf("?>", i) + 2;
    } else if (xml.startsWith("</", i)) {
      const fin = xml.indexOf(">", i);
      const nombre = xml.slice(i + 2, fin).trim();
      const abierto = pila.pop();
      if (!abierto || abierto.nombre !== nombre)
        throw new Error(`XML mal formado: se cierra ${nombre} y estaba abierto ${abierto?.nombre}`);
      i = fin + 1;
    } else if (xml[i] === "<") {
      const m = /^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(xml.slice(i));
      if (!m) throw new Error(`XML mal formado cerca de: ${xml.slice(i, i + 40)}`);
      const atributos: Record<string, string> = {};
      for (const a of m[2]!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
        atributos[a[1]!] = decodificar(a[2] ?? a[3] ?? "");
      const nodo: Nodo = { nombre: m[1]!, atributos, hijos: [] };
      pila[pila.length - 1]!.hijos.push(nodo);
      if (!m[3]) pila.push(nodo);
      i += m[0].length;
    } else {
      const sig = xml.indexOf("<", i);
      i = sig === -1 ? xml.length : sig;
    }
  }
  if (pila.length !== 1) throw new Error(`XML mal formado: quedó abierto ${pila[pila.length - 1]!.nombre}`);
  return raiz.hijos[0]!;
}

// ------------------------------------------------------------------------------------------- XPath (subconjunto)

type Valor = string | number | boolean;

export interface Mensaje {
  /** Propiedades del contexto de mensaje (ámbito por omisión). */
  propiedades: Record<string, string>;
  /** Propiedades del ámbito axis2 (por ejemplo HTTP_SC). */
  axis2: Record<string, string>;
  /** Encabezados de transporte del mensaje. */
  transporte: Record<string, string>;
  /** Cuerpo JSON del mensaje (para json-eval). */
  cuerpo: unknown;
}

const aNumero = (v: Valor): number =>
  typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : v.trim() === "" ? NaN : Number(v.trim());
const aCadena = (v: Valor): string => {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
  return String(v);
};
const aBooleano = (v: Valor): boolean =>
  typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 && !Number.isNaN(v) : v.length > 0;

function compararValores(op: string, a: Valor, b: Valor): boolean {
  if (op === "=" || op === "!=") {
    let igual: boolean;
    if (typeof a === "boolean" || typeof b === "boolean") igual = aBooleano(a) === aBooleano(b);
    else if (typeof a === "number" || typeof b === "number") igual = aNumero(a) === aNumero(b);
    else igual = a === b;
    return op === "=" ? igual : !igual;
  }
  const x = aNumero(a);
  const y = aNumero(b);
  return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
}

function jsonEval(cuerpo: unknown, ruta: string): string {
  let actual: unknown = cuerpo;
  for (const parte of ruta
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean)) {
    actual = actual && typeof actual === "object" ? (actual as Record<string, unknown>)[parte] : undefined;
  }
  return actual === undefined || actual === null
    ? ""
    : typeof actual === "object"
      ? JSON.stringify(actual)
      : String(actual);
}

/** Evalúa una expresión XPath 1.0 del subconjunto que usan las secuencias, con las funciones de Synapse. */
export function evaluar(expresion: string, m: Mensaje): Valor {
  const fichas = (
    expresion.match(/'[^']*'|"[^"]*"|\$[\w-]+:[\w-]+|json-eval\([^)]*\)|!=|<=|>=|[()=<>,+-]|[\w:.-]+|\S/g) ??
    []
  ).filter((f) => f.trim());
  let p = 0;
  const ver = () => fichas[p];
  const tomar = (esperada?: string) => {
    const f = fichas[p++];
    if (esperada !== undefined && f !== esperada)
      throw new Error(`XPath: se esperaba «${esperada}» y vino «${f}» en ${expresion}`);
    return f!;
  };
  const llamar = (fn: string, args: Valor[]): Valor => {
    switch (fn) {
      case "get-property": {
        const [a, b] = args.map(aCadena);
        if (b === undefined) return m.propiedades[a!] ?? "";
        const ambito = a!.toLowerCase();
        const fuente = ambito === "axis2" ? m.axis2 : ambito === "transport" ? m.transporte : m.propiedades;
        return fuente[b] ?? "";
      }
      case "number":
        return aNumero(args[0] ?? "");
      case "string":
        return aCadena(args[0] ?? "");
      case "boolean":
        return aBooleano(args[0] ?? "");
      case "not":
        return !aBooleano(args[0] ?? false);
      case "fn:concat":
      case "concat":
        return args.map(aCadena).join("");
      default:
        throw new Error(`XPath: función no soportada por el simulador: ${fn}`);
    }
  };
  const primario = (): Valor => {
    const f = tomar();
    if (f === "(") {
      const v = o();
      tomar(")");
      return v;
    }
    if (f.startsWith("'") || f.startsWith('"')) return f.slice(1, -1);
    if (/^\d+(\.\d+)?$/.test(f)) return Number(f);
    if (f.startsWith("json-eval(")) return jsonEval(m.cuerpo, f.slice("json-eval(".length, -1).trim());
    if (f.startsWith("$")) {
      const [ambito, nombre] = f.slice(1).split(":") as [string, string];
      const fuente =
        ambito === "axis2"
          ? m.axis2
          : ambito === "trp"
            ? m.transporte
            : ambito === "ctx"
              ? m.propiedades
              : undefined;
      if (!fuente) throw new Error(`XPath: variable no soportada por el simulador: ${f}`);
      return fuente[nombre] ?? "";
    }
    if (ver() === "(") {
      tomar("(");
      const args: Valor[] = [];
      while (ver() !== ")") {
        args.push(o());
        if (ver() === ",") tomar(",");
      }
      tomar(")");
      return llamar(f, args);
    }
    throw new Error(`XPath: ficha no soportada por el simulador: ${f} en ${expresion}`);
  };
  const aditiva = (): Valor => {
    let v = primario();
    while (ver() === "+" || ver() === "-") {
      const op = tomar();
      const d = primario();
      v = op === "+" ? aNumero(v) + aNumero(d) : aNumero(v) - aNumero(d);
    }
    return v;
  };
  const comparacion = (): Valor => {
    let v = aditiva();
    while (["=", "!=", "<", "<=", ">", ">="].includes(ver() ?? "")) {
      const op = tomar();
      v = compararValores(op, v, aditiva());
    }
    return v;
  };
  const y = (): Valor => {
    let v = comparacion();
    while (ver() === "and") {
      tomar();
      const d = comparacion();
      v = aBooleano(v) && aBooleano(d);
    }
    return v;
  };
  const o = (): Valor => {
    let v = y();
    while (ver() === "or") {
      tomar();
      const d = y();
      v = aBooleano(v) || aBooleano(d);
    }
    return v;
  };
  const resultado = o();
  if (p !== fichas.length) throw new Error(`XPath: sobra «${fichas.slice(p).join(" ")}» en ${expresion}`);
  return resultado;
}

/** Synapse compara las expresiones regulares de filter y switch con la cadena completa (Matcher.matches). */
export const coincideCompleta = (regex: string, valor: string) => new RegExp(`^(?:${regex})$`).test(valor);

// ------------------------------------------------------------------------------------------------- ejecución

export interface Llamada {
  endpoint: string;
  encabezados: Record<string, string>;
}

export interface Registro {
  propiedades: Record<string, string>;
}

/** Respuesta del destino ante una llamada: un código HTTP o una falla de red / tiempo de espera. */
export type Respuesta = { status: number } | { falla: { codigo: string; mensaje: string } };

export interface Resultado {
  llamadas: Llamada[];
  registros: Registro[];
  mensaje: Mensaje;
}

class Fin extends Error {}
class Falla extends Error {
  constructor(
    readonly codigo: string,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

/** Carga las secuencias de una carpeta de artefactos de Micro Integrator. */
export function cargarSecuencias(dirArtefactos: string, nombres: string[]): Map<string, Nodo> {
  const mapa = new Map<string, Nodo>();
  for (const n of nombres) {
    const nodo = analizarXml(readFileSync(join(dirArtefactos, "sequences", `${n}.xml`), "utf8"));
    if (nodo.atributos.name !== n)
      throw new Error(`la secuencia ${n}.xml declara name=${nodo.atributos.name}`);
    mapa.set(n, nodo);
  }
  return mapa;
}

/**
 * Ejecuta una secuencia con un mensaje de entrada. `responder` decide qué contesta cada endpoint llamado; las
 * colas (endpoints Cola*) aceptan siempre. Una falla en un call desvía a la secuencia onError, como en Synapse.
 */
export function ejecutarSecuencia(
  secuencias: Map<string, Nodo>,
  nombre: string,
  mensaje: Mensaje,
  responder: (endpoint: string) => Respuesta,
): Resultado {
  const llamadas: Llamada[] = [];
  const registros: Registro[] = [];
  const cadena = (expr: string) => aCadena(evaluar(expr, mensaje));
  const valorDe = (n: Nodo) =>
    n.atributos.expression !== undefined ? cadena(n.atributos.expression) : (n.atributos.value ?? "");

  const mediar = (lista: Nodo[]) => {
    for (const n of lista) mediador(n);
  };
  const rama = (n: Nodo, cumple: boolean) => {
    const then = n.hijos.find((h) => h.nombre === "then");
    const otra = n.hijos.find((h) => h.nombre === "else");
    if (!then && !otra) {
      if (cumple) mediar(n.hijos);
    } else if (cumple) mediar(then?.hijos ?? []);
    else mediar(otra?.hijos ?? []);
  };
  const mediador = (n: Nodo) => {
    const a = n.atributos;
    switch (n.nombre) {
      case "property": {
        const ambito = a.scope ?? "default";
        const destino =
          ambito === "axis2"
            ? mensaje.axis2
            : ambito === "transport"
              ? mensaje.transporte
              : mensaje.propiedades;
        if (a.action === "remove") delete destino[a.name!];
        else destino[a.name!] = valorDe(n);
        return;
      }
      case "header":
        if (a.action === "remove") delete mensaje.transporte[a.name!];
        else mensaje.transporte[a.name!] = valorDe(n);
        return;
      case "log":
        registros.push({
          propiedades: Object.fromEntries(
            n.hijos.filter((h) => h.nombre === "property").map((h) => [h.atributos.name!, valorDe(h)]),
          ),
        });
        return;
      case "filter":
        if (a.xpath !== undefined) rama(n, aBooleano(evaluar(a.xpath, mensaje)));
        else rama(n, coincideCompleta(a.regex!, cadena(a.source!)));
        return;
      case "switch": {
        const valor = cadena(a.source!);
        const caso =
          n.hijos.find((h) => h.nombre === "case" && coincideCompleta(h.atributos.regex!, valor)) ??
          n.hijos.find((h) => h.nombre === "default");
        mediar(caso?.hijos ?? []);
        return;
      }
      case "sequence":
        ejecutar(a.key!);
        return;
      case "call": {
        const ep = n.hijos.find((h) => h.nombre === "endpoint")?.atributos.key;
        if (!ep) throw new Error("call sin endpoint con key");
        llamadas.push({ endpoint: ep, encabezados: { ...mensaje.transporte } });
        const r = ep.startsWith("Cola") ? { status: 200 } : responder(ep);
        if ("falla" in r) throw new Falla(r.falla.codigo, r.falla.mensaje);
        mensaje.axis2.HTTP_SC = String(r.status);
        return;
      }
      case "drop":
      case "respond":
        throw new Fin();
      case "enrich":
      case "payloadFactory":
        return;
      default:
        throw new Error(`mediador no soportado por el simulador: ${n.nombre}`);
    }
  };
  const ejecutar = (clave: string) => {
    const s = secuencias.get(clave);
    if (!s) throw new Error(`secuencia no cargada: ${clave}`);
    try {
      mediar(s.hijos);
    } catch (e) {
      if (!(e instanceof Falla) || !s.atributos.onError) throw e;
      mensaje.propiedades.ERROR_CODE = e.codigo;
      mensaje.propiedades.ERROR_MESSAGE = e.message;
      ejecutar(s.atributos.onError);
      throw new Fin();
    }
  };
  try {
    ejecutar(nombre);
  } catch (e) {
    if (!(e instanceof Fin)) throw e;
  }
  return { llamadas, registros, mensaje };
}
