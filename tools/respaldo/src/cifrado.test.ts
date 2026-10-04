import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cifrarBuffer,
  descifrarBuffer,
  firmaValida,
  firmar,
  generarClaveHex,
  huellaClave,
  interpretarClave,
} from "./cifrado.js";

const clave = randomBytes(32);
const BLOQUE = 64;
const CABECERA = 28;
const ETIQUETA = 16;

describe("cifrado por bloques AES-256-GCM", () => {
  it.each([0, 1, BLOQUE - 1, BLOQUE, BLOQUE + 1, 3 * BLOQUE, 10_000])(
    "ida y vuelta con %i bytes",
    async (n) => {
      const claro = randomBytes(n);
      const cifrado = await cifrarBuffer(clave, claro, { tamanoBloque: BLOQUE });
      expect(cifrado.subarray(0, 8).toString("ascii")).toBe("NEXORSP1");
      // cabecera + bloques llenos + último bloque (puede ir vacío) + una etiqueta por bloque
      const bloques = Math.max(1, Math.ceil(n / BLOQUE));
      expect(cifrado.length).toBe(CABECERA + n + bloques * ETIQUETA);
      expect((await descifrarBuffer(clave, cifrado)).equals(claro)).toBe(true);
    },
  );

  it("con el tamaño de bloque por omisión (1 MiB) y datos de varios bloques", async () => {
    const claro = randomBytes(2.5 * 1024 * 1024);
    const cifrado = await cifrarBuffer(clave, claro);
    expect((await descifrarBuffer(clave, cifrado)).equals(claro)).toBe(true);
  });

  it("dos cifrados del mismo contenido no se parecen (sal por archivo)", async () => {
    const claro = Buffer.alloc(200, 7);
    const a = await cifrarBuffer(clave, claro, { tamanoBloque: BLOQUE });
    const b = await cifrarBuffer(clave, claro, { tamanoBloque: BLOQUE });
    expect(a.equals(b)).toBe(false);
  });

  describe("detecta alteraciones (GCM)", () => {
    const claro = randomBytes(5 * BLOQUE + 10);
    const preparar = () => cifrarBuffer(clave, claro, { tamanoBloque: BLOQUE });

    it("un bit cambiado en el contenido cifrado", async () => {
      const c = await preparar();
      c[CABECERA + 3 * (BLOQUE + ETIQUETA) + 5]! ^= 0x01;
      await expect(descifrarBuffer(clave, c)).rejects.toThrow(/bloque 3 no pasa la verificación/);
    });

    it("una etiqueta alterada", async () => {
      const c = await preparar();
      c[c.length - 1]! ^= 0x80;
      await expect(descifrarBuffer(clave, c)).rejects.toThrow(/verificación de integridad/);
    });

    it("la cabecera alterada (va como dato autenticado)", async () => {
      const c = await preparar();
      c[CABECERA - 1]! ^= 0x01; // último byte de la sal
      await expect(descifrarBuffer(clave, c)).rejects.toThrow(/verificación de integridad/);
    });

    it("un archivo truncado justo en el borde de un bloque", async () => {
      const c = await preparar();
      const truncado = c.subarray(0, CABECERA + 3 * (BLOQUE + ETIQUETA));
      await expect(descifrarBuffer(clave, truncado)).rejects.toThrow(/verificación de integridad/);
    });

    it("un archivo truncado a mitad de bloque o sin cabecera", async () => {
      const c = await preparar();
      await expect(descifrarBuffer(clave, c.subarray(0, c.length - 7))).rejects.toThrow();
      await expect(descifrarBuffer(clave, c.subarray(0, 10))).rejects.toThrow(/sin cabecera/);
    });

    it("datos agregados al final", async () => {
      const c = await preparar();
      await expect(
        descifrarBuffer(clave, Buffer.concat([c, randomBytes(BLOQUE + ETIQUETA)])),
      ).rejects.toThrow();
    });

    it("dos bloques intercambiados", async () => {
      const c = await preparar();
      const b1 = CABECERA;
      const largo = BLOQUE + ETIQUETA;
      const copia = Buffer.from(c);
      c.copy(copia, b1, b1 + largo, b1 + 2 * largo);
      c.copy(copia, b1 + largo, b1, b1 + largo);
      await expect(descifrarBuffer(clave, copia)).rejects.toThrow(/bloque 0/);
    });

    it("otra clave", async () => {
      const c = await preparar();
      await expect(descifrarBuffer(randomBytes(32), c)).rejects.toThrow(/clave incorrecta/);
    });

    it("un archivo que no es un respaldo cifrado", async () => {
      await expect(descifrarBuffer(clave, randomBytes(500))).rejects.toThrow(/cabecera desconocida/);
    });
  });
});

describe("clave maestra", () => {
  it("acepta 32 bytes en hexadecimal o base64", () => {
    const k = randomBytes(32);
    expect(interpretarClave(Buffer.from(`${k.toString("hex")}\n`)).equals(k)).toBe(true);
    expect(interpretarClave(Buffer.from(k.toString("base64"))).equals(k)).toBe(true);
    expect(interpretarClave(Buffer.from(generarClaveHex())).length).toBe(32);
  });

  it("rechaza contraseñas, textos cortos y otros formatos", () => {
    expect(() => interpretarClave(Buffer.from("secreto"))).toThrow(/32 bytes/);
    // 32 caracteres de texto no son 32 bytes aleatorios
    expect(() => interpretarClave(Buffer.from("una-contraseña-de-32-caracteres!"))).toThrow(/32 bytes/);
    expect(() => interpretarClave(Buffer.from("ab".repeat(16)))).toThrow(/32 bytes/);
  });

  it("la huella identifica la clave sin revelarla", () => {
    const k = randomBytes(32);
    expect(huellaClave(k)).toMatch(/^[0-9a-f]{16}$/);
    expect(huellaClave(k)).toBe(huellaClave(Buffer.from(k)));
    expect(huellaClave(k)).not.toBe(huellaClave(randomBytes(32)));
    expect(k.toString("hex")).not.toContain(huellaClave(k));
  });

  it("la firma HMAC valida el texto exacto y solo con la misma clave", () => {
    const k = randomBytes(32);
    const f = firmar(k, "manifiesto");
    expect(firmaValida(k, "manifiesto", f)).toBe(true);
    expect(firmaValida(k, "manifiestO", f)).toBe(false);
    expect(firmaValida(randomBytes(32), "manifiesto", f)).toBe(false);
    expect(firmaValida(k, "manifiesto", "no-es-hex")).toBe(false);
  });
});
