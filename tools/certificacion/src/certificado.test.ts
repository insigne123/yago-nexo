import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { leerBanco, leerPractico } from "./banco.js";
import {
  PROGRAMA,
  buscarEnRegistro,
  certificadoPdf,
  codigoCertificado,
  crearCertificado,
  documentoParaMostrar,
  hashCertificado,
  leerCertificadoPdf,
  lineaRegistro,
  normalizarDocumento,
  sumarAnos,
  verificarCertificado,
  type Certificado,
} from "./certificado.js";
import { corregir, validarHoja, type Resultado } from "./correccion.js";
import { sortearExamen } from "./sorteo.js";

const examen = sortearExamen(leerBanco(), "certificado");
const practico = leerPractico();

function resultado(nombre = "Persona de Prueba", documento = "11.111.111-1", buenas = 34): Resultado {
  const respuestas = Object.fromEntries(
    examen.preguntas.map((p, i) => [
      String(p.n),
      i < buenas ? p.correcta : ({ a: "b", b: "c", c: "d", d: "a" } as const)[p.correcta],
    ]),
  );
  const hoja = validarHoja({
    examen: examen.id,
    participante: { nombre, documento },
    respuestas,
    practico: {
      evaluador: "Instructora",
      tareas: { P1: "aprobada", P2: "aprobada", P3: "aprobada", P4: "aprobada", P5: "reprobada" },
    },
  });
  return corregir(examen, practico, hoja);
}

const OPC = { fecha: "2026-11-27", versionProducto: "1.0.0" };

describe("documento de identidad", () => {
  it("normaliza y valida un RUT", () => {
    expect(normalizarDocumento("11.111.111-1")).toBe("11111111-1");
    expect(normalizarDocumento(" 11111111-1 ")).toBe("11111111-1");
    expect(normalizarDocumento("6.565.573-k")).toBe("6565573-K");
    expect(() => normalizarDocumento("11.111.111-2")).toThrow(/dígito verificador/);
    expect(documentoParaMostrar("11111111-1")).toBe("11.111.111-1");
  });

  it("acepta otros documentos (por ejemplo, un pasaporte) y rechaza basura", () => {
    expect(normalizarDocumento("ab 123456")).toBe("AB123456");
    expect(() => normalizarDocumento("x")).toThrow();
    expect(() => normalizarDocumento("12;DROP")).toThrow();
  });
});

describe("vigencia", () => {
  it("dura dos años y ajusta el 29 de febrero", () => {
    expect(sumarAnos("2026-11-27", 2)).toBe("2028-11-27");
    expect(sumarAnos("2028-02-29", 2)).toBe("2030-02-28");
    expect(() => sumarAnos("2026-02-30", 2)).toThrow(/no existe/);
  });
});

describe("código y hash del certificado", () => {
  it("son deterministas: los mismos datos dan el mismo código y el mismo hash", () => {
    const a = crearCertificado(resultado(), OPC);
    const b = crearCertificado(resultado(), OPC);
    expect(b.codigo).toBe(a.codigo);
    expect(b.hash).toBe(a.hash);
    expect(a.codigo).toMatch(/^YNX-1-2026-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.programa).toBe(PROGRAMA);
    expect(a.vigenteHasta).toBe("2028-11-27");
    expect(a.notaTeorica).toBe(85);
  });

  it("el código cambia con la persona, la fecha, la versión o el examen", () => {
    const base = crearCertificado(resultado(), OPC);
    const otros = [
      crearCertificado(resultado("Persona de Prueba", "22.222.222-2"), OPC),
      crearCertificado(resultado(), { ...OPC, fecha: "2026-11-28" }),
      crearCertificado(resultado(), { ...OPC, versionProducto: "1.1.0" }),
    ];
    for (const o of otros) expect(o.codigo).not.toBe(base.codigo);
    const otroExamen = codigoCertificado({ ...base, examen: "otro" });
    expect(otroExamen).not.toBe(base.codigo);
  });

  it("el hash cubre el nombre y la nota, aunque el código no cambie", () => {
    const a = crearCertificado(resultado("Persona de Prueba"), OPC);
    const b = crearCertificado(resultado("Persona  de   Prueba"), OPC); // espacios normalizados
    expect(b.hash).toBe(a.hash);
    const c = crearCertificado(resultado("Otra Persona"), OPC);
    expect(c.codigo).toBe(a.codigo);
    expect(c.hash).not.toBe(a.hash);
    expect(hashCertificado({ ...a, notaTeorica: 99 })).not.toBe(a.hash);
  });

  it("no se emite para un resultado reprobado", () => {
    expect(() => crearCertificado(resultado("Persona de Prueba", "11.111.111-1", 20), OPC)).toThrow(
      /no está aprobado/,
    );
  });

  it("la verificación detecta alteraciones y vencimiento", () => {
    const c = crearCertificado(resultado(), OPC);
    expect(verificarCertificado(c, "2027-01-01")).toMatchObject({ integro: true, vigente: true });
    expect(verificarCertificado(c, "2028-11-27")).toMatchObject({ integro: true, vigente: true });
    expect(verificarCertificado(c, "2028-11-28")).toMatchObject({ integro: true, vigente: false });
    expect(verificarCertificado({ ...c, nombre: "Otra Persona" }, "2027-01-01").integro).toBe(false);
    expect(verificarCertificado({ ...c, documento: "22222222-2" }, "2027-01-01").integro).toBe(false);
    expect(verificarCertificado({ ...c, vigenteHasta: "2099-01-01" }, "2027-01-01").integro).toBe(false);
  });
});

describe("PDF del certificado", () => {
  it("es un PDF válido de una página que pdf-lib puede leer, con los datos incluidos", async () => {
    const c = crearCertificado(resultado("María José Núñez Peña"), OPC);
    const bytes = await certificadoPdf(c);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe(PROGRAMA);
    expect(doc.getSubject()).toBe(`Certificado ${c.codigo}`);
    const leido = await leerCertificadoPdf(bytes);
    expect(leido).toEqual(c);
    expect(verificarCertificado(leido, "2027-06-01")).toMatchObject({ integro: true, vigente: true });
  });

  it("los mismos datos generan exactamente el mismo archivo", async () => {
    const c = crearCertificado(resultado(), OPC);
    const [a, b] = await Promise.all([certificadoPdf(c), certificadoPdf(c)]);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });

  it("rechaza un PDF que no es un certificado de Nexo", async () => {
    const otro = await PDFDocument.create();
    otro.addPage();
    otro.setTitle("otro");
    await expect(leerCertificadoPdf(await otro.save())).rejects.toThrow(/no contiene/);
  });
});

describe("registro de certificados emitidos", () => {
  it("encuentra un código y lo verifica", () => {
    const a = crearCertificado(resultado(), OPC);
    const b = crearCertificado(resultado("Otra Persona", "22.222.222-2"), OPC);
    const registro = lineaRegistro(a) + lineaRegistro(b);
    const hallado = buscarEnRegistro(registro, b.codigo.toLowerCase()) as Certificado;
    expect(hallado).toEqual(b);
    expect(buscarEnRegistro(registro, "YNX-1-2026-0000-0000")).toBeUndefined();
  });
});
