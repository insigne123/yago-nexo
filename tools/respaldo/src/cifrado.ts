// Cifrado en reposo de los respaldos (BT-053).
//
// Formato NEXORSP1 (un archivo por artefacto):
//   cabecera (28 bytes): "NEXORSP1" | tamaño de bloque (uint32 BE) | sal aleatoria (16 bytes)
//   bloques: AES-256-GCM, cada uno con su etiqueta de 16 bytes; el último lleva la marca "final".
//
// - La clave de cada archivo se deriva de la clave maestra con HKDF-SHA256 y la sal del archivo:
//   ningún par clave/nonce se repite entre archivos.
// - El nonce de cada bloque es su número correlativo más la marca final, y la cabecera va como
//   dato autenticado: se detecta un bloque alterado, reordenado, quitado o agregado, un archivo
//   truncado y una cabecera modificada.
// - Cifrar y descifrar es por flujo: el respaldo sin cifrar nunca se escribe en disco, y al
//   descifrar cada bloque se autentica antes de entregar su contenido.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { Transform, type TransformCallback } from "node:stream";

export const ALGORITMO = "AES-256-GCM";
export const ESQUEMA = "NEXORSP1";
export const KDF = "HKDF-SHA256";
export const TAMANO_BLOQUE_POR_OMISION = 1024 * 1024;

const MAGIA = Buffer.from(ESQUEMA, "ascii");
const LARGO_SAL = 16;
const LARGO_CABECERA = MAGIA.length + 4 + LARGO_SAL;
const LARGO_ETIQUETA = 16;
const BLOQUE_MAXIMO = 64 * 1024 * 1024;
const MAX_BLOQUES = 0xffffffff;

export class ErrorCifrado extends Error {}

/**
 * Interpreta el contenido de un archivo de clave: 64 caracteres hexadecimales o base64 de 32 bytes.
 * Cualquier otra cosa es un error: no se acepta una contraseña ni un texto corto como clave.
 */
export function interpretarClave(contenido: Buffer): Buffer {
  const texto = contenido.toString("utf8").trim();
  if (/^[0-9a-f]{64}$/i.test(texto)) return Buffer.from(texto, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(texto)) {
    const b = Buffer.from(texto, "base64");
    if (b.length === 32) return b;
  }
  throw new ErrorCifrado(
    "el archivo de clave debe contener 32 bytes aleatorios: 64 caracteres hexadecimales o base64",
  );
}

/** Clave nueva, en hexadecimal, para escribir en un archivo de clave. */
export function generarClaveHex(): string {
  return randomBytes(32).toString("hex");
}

function derivar(clave: Buffer, sal: Buffer, contexto: string): Buffer {
  return Buffer.from(hkdfSync("sha256", clave, sal, Buffer.from(contexto, "utf8"), 32));
}

/**
 * Huella pública de la clave maestra (no permite recuperarla). Va en el manifiesto para saber con
 * qué clave se cifró un respaldo y avisar antes de intentar descifrar con otra.
 */
export function huellaClave(clave: Buffer): string {
  return derivar(clave, Buffer.alloc(0), "nexo-respaldo huella v1").subarray(0, 8).toString("hex");
}

/** Firma HMAC-SHA256 (con una clave derivada, distinta de la de cifrado) de un texto. */
export function firmar(clave: Buffer, texto: string): string {
  return createHmac("sha256", derivar(clave, Buffer.alloc(0), "nexo-respaldo manifiesto v1"))
    .update(texto, "utf8")
    .digest("hex");
}

export function firmaValida(clave: Buffer, texto: string, firma: string): boolean {
  const esperada = Buffer.from(firmar(clave, texto), "hex");
  const recibida = Buffer.from(/^[0-9a-f]{64}$/i.test(firma) ? firma : "", "hex");
  return recibida.length === esperada.length && timingSafeEqual(esperada, recibida);
}

function nonce(contador: number, final: boolean): Buffer {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(contador, 7);
  n[11] = final ? 1 : 0;
  return n;
}

/** Acumulador de trozos: evita concatenar el búfer completo con cada trozo que llega. */
class Acumulador {
  private partes: Buffer[] = [];
  largo = 0;

  agregar(b: Buffer): void {
    if (b.length === 0) return;
    this.partes.push(b);
    this.largo += b.length;
  }

  /** Saca exactamente n bytes del comienzo (n <= largo). */
  sacar(n: number): Buffer {
    const todo = this.partes.length === 1 ? this.partes[0]! : Buffer.concat(this.partes, this.largo);
    const fuera = todo.subarray(0, n);
    const resto = todo.subarray(n);
    this.partes = resto.length ? [resto] : [];
    this.largo = resto.length;
    return fuera;
  }
}

export interface OpcionesCifrador {
  /** Tamaño del bloque en claro (por omisión 1 MiB). */
  tamanoBloque?: number;
}

/** Flujo que cifra lo que recibe y emite el archivo NEXORSP1 completo. */
export function crearCifrador(clave: Buffer, opciones: OpcionesCifrador = {}): Transform {
  const tamano = opciones.tamanoBloque ?? TAMANO_BLOQUE_POR_OMISION;
  if (!Number.isInteger(tamano) || tamano < 1 || tamano > BLOQUE_MAXIMO)
    throw new ErrorCifrado(`tamaño de bloque inválido: ${tamano}`);
  if (clave.length !== 32) throw new ErrorCifrado("la clave debe tener 32 bytes");
  const sal = randomBytes(LARGO_SAL);
  const cabecera = Buffer.alloc(LARGO_CABECERA);
  MAGIA.copy(cabecera, 0);
  cabecera.writeUInt32BE(tamano, MAGIA.length);
  sal.copy(cabecera, MAGIA.length + 4);
  const claveArchivo = derivar(clave, sal, "nexo-respaldo archivo v1");
  const pendiente = new Acumulador();
  let contador = 0;
  let cabeceraEnviada = false;

  const sellar = (datos: Buffer, final: boolean): Buffer => {
    if (contador >= MAX_BLOQUES) throw new ErrorCifrado("el archivo supera el máximo de bloques del formato");
    const c = createCipheriv("aes-256-gcm", claveArchivo, nonce(contador++, final), {
      authTagLength: LARGO_ETIQUETA,
    });
    c.setAAD(cabecera);
    return Buffer.concat([c.update(datos), c.final(), c.getAuthTag()]);
  };

  return new Transform({
    transform(trozo: Buffer, _codificacion: BufferEncoding, listo: TransformCallback) {
      try {
        if (!cabeceraEnviada) {
          this.push(cabecera);
          cabeceraEnviada = true;
        }
        pendiente.agregar(trozo);
        // Un bloque se sella solo cuando se sabe que no es el último (llegó al menos un byte más).
        while (pendiente.largo > tamano) this.push(sellar(pendiente.sacar(tamano), false));
        listo();
      } catch (e) {
        listo(e as Error);
      }
    },
    flush(listo: TransformCallback) {
      try {
        if (!cabeceraEnviada) this.push(cabecera);
        this.push(sellar(pendiente.sacar(pendiente.largo), true));
        listo();
      } catch (e) {
        listo(e as Error);
      }
    },
  });
}

/** Flujo que verifica y descifra un archivo NEXORSP1. Falla ante cualquier alteración. */
export function crearDescifrador(clave: Buffer): Transform {
  if (clave.length !== 32) throw new ErrorCifrado("la clave debe tener 32 bytes");
  const pendiente = new Acumulador();
  let cabecera: Buffer | undefined;
  let claveArchivo: Buffer | undefined;
  let bloqueCifrado = 0;
  let contador = 0;

  const abrir = (datos: Buffer, final: boolean): Buffer => {
    if (datos.length < LARGO_ETIQUETA) throw new ErrorCifrado("archivo cifrado truncado");
    const d = createDecipheriv("aes-256-gcm", claveArchivo!, nonce(contador, final), {
      authTagLength: LARGO_ETIQUETA,
    });
    d.setAAD(cabecera!);
    d.setAuthTag(datos.subarray(datos.length - LARGO_ETIQUETA));
    try {
      const claro = Buffer.concat([d.update(datos.subarray(0, datos.length - LARGO_ETIQUETA)), d.final()]);
      contador++;
      return claro;
    } catch {
      throw new ErrorCifrado(
        `el bloque ${contador} no pasa la verificación de integridad: archivo alterado o truncado, o clave incorrecta`,
      );
    }
  };

  return new Transform({
    transform(trozo: Buffer, _codificacion: BufferEncoding, listo: TransformCallback) {
      try {
        pendiente.agregar(trozo);
        if (!cabecera) {
          if (pendiente.largo < LARGO_CABECERA) return listo();
          cabecera = Buffer.from(pendiente.sacar(LARGO_CABECERA));
          if (!cabecera.subarray(0, MAGIA.length).equals(MAGIA))
            throw new ErrorCifrado("no es un respaldo cifrado de Nexo (cabecera desconocida)");
          const tamano = cabecera.readUInt32BE(MAGIA.length);
          if (tamano < 1 || tamano > BLOQUE_MAXIMO)
            throw new ErrorCifrado(`cabecera inválida: tamaño de bloque ${tamano}`);
          bloqueCifrado = tamano + LARGO_ETIQUETA;
          claveArchivo = derivar(clave, cabecera.subarray(MAGIA.length + 4), "nexo-respaldo archivo v1");
        }
        while (pendiente.largo > bloqueCifrado) this.push(abrir(pendiente.sacar(bloqueCifrado), false));
        listo();
      } catch (e) {
        listo(e as Error);
      }
    },
    flush(listo: TransformCallback) {
      try {
        if (!cabecera) throw new ErrorCifrado("archivo cifrado truncado (sin cabecera completa)");
        this.push(abrir(pendiente.sacar(pendiente.largo), true));
        listo();
      } catch (e) {
        listo(e as Error);
      }
    },
  });
}

/** Paso intermedio que cuenta bytes y calcula el SHA-256 de lo que pasa por él. */
export class Medidor extends Transform {
  bytes = 0;
  private readonly hash = createHash("sha256");

  override _transform(trozo: Buffer, _codificacion: BufferEncoding, listo: TransformCallback): void {
    this.bytes += trozo.length;
    this.hash.update(trozo);
    listo(null, trozo);
  }

  /** SHA-256 en hexadecimal; solo es válido cuando el flujo terminó. */
  sha256(): string {
    return this.hash.copy().digest("hex");
  }
}

export async function sha256Archivo(ruta: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const trozo of createReadStream(ruta)) {
    hash.update(trozo as Buffer);
    bytes += (trozo as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Utilidades en memoria (pruebas y archivos pequeños). */
export async function cifrarBuffer(
  clave: Buffer,
  datos: Buffer,
  opciones: OpcionesCifrador = {},
): Promise<Buffer> {
  return aplicar(crearCifrador(clave, opciones), datos);
}

export async function descifrarBuffer(clave: Buffer, datos: Buffer): Promise<Buffer> {
  return aplicar(crearDescifrador(clave), datos);
}

async function aplicar(flujo: Transform, datos: Buffer): Promise<Buffer> {
  const salida: Buffer[] = [];
  flujo.on("data", (b: Buffer) => salida.push(b));
  const fin = new Promise<void>((ok, mal) => {
    flujo.on("end", ok);
    flujo.on("error", mal);
  });
  // Se entrega en trozos de tamaño variable para ejercitar los bordes de bloque.
  for (let i = 0; i < datos.length; i += 7919) flujo.write(datos.subarray(i, i + 7919));
  flujo.end();
  await fin;
  return Buffer.concat(salida);
}
