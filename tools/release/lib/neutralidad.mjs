// Guarda de neutralidad del repositorio (sin E/S): el repositorio es público y no nombra a la institución
// compradora ni el identificador del proceso de compra. Los patrones se arman por partes para que este archivo
// no contenga el texto literal que busca. La usa tools/release/verificar-neutralidad.mjs (job del CI) y la prueba
// tools/release/test/neutralidad.test.mjs.

/** Términos prohibidos (sin distinguir mayúsculas). */
export const TERMINOS = [
  { nombre: "institución compradora", patron: new RegExp(["s", "[u]", "b", "t", "e", "l"].join(""), "gi") },
  // Con bordes alfanuméricos: no confunde el identificador con trozos de UUID o de hashes (p. ej. «1606-26b4»).
  {
    nombre: "identificador del proceso de compra",
    patron: new RegExp(["(?<![0-9a-z])", "6", "[0]", "6", "-", "2", "6", "(?![0-9a-z])"].join(""), "gi"),
  },
];

/**
 * Archivos que pueden nombrar los términos, con el máximo de apariciones y el motivo. Si el archivo cambia y
 * agrega una aparición más, la guarda falla igual.
 */
export const PERMITIDOS = [
  {
    ruta: "apps/site/scripts/lib.mjs",
    maximo: 2,
    motivo: "Regla del sitio (check-public-content) que impide publicar el nombre y el identificador.",
  },
  {
    ruta: "tools/evidencias/src/lib/grabador.ts",
    maximo: 2,
    motivo:
      "Regla del grabador de videos que detiene una toma si el nombre o el identificador aparecen en pantalla.",
  },
  {
    ruta: "supabase/support/migrations/20261005090000_nexo_sd_nombres_neutros.sql",
    maximo: 1,
    motivo:
      "Migración ya aplicada que renombra el prefijo anterior a nombres neutros: debe nombrar el prefijo que reemplaza.",
  },
];

/** Cuenta las apariciones de los términos en un texto. Devuelve [{termino, linea, columna}]. */
export function buscar(texto) {
  const hallazgos = [];
  const lineas = texto.split("\n");
  for (const t of TERMINOS) {
    lineas.forEach((l, i) => {
      t.patron.lastIndex = 0;
      for (const m of l.matchAll(t.patron))
        hallazgos.push({ termino: t.nombre, linea: i + 1, columna: m.index + 1 });
    });
  }
  return hallazgos;
}

/** true si el contenido parece binario (tiene bytes nulos al comienzo). */
export function esBinario(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * Evalúa los archivos del repositorio. Recibe [{ruta, contenido: Buffer | string}] y devuelve las
 * infracciones [{ruta, detalle}]: apariciones fuera de los permitidos, más apariciones de las permitidas,
 * y rutas (nombres de archivo o carpeta) que contengan un término.
 */
export function evaluar(archivos, permitidos = PERMITIDOS) {
  const infracciones = [];
  const porRuta = new Map(permitidos.map((p) => [p.ruta, p]));
  for (const { ruta, contenido } of archivos) {
    const enRuta = buscar(ruta);
    if (enRuta.length)
      infracciones.push({ ruta, detalle: `el nombre del archivo contiene «${enRuta[0].termino}»` });
    const buffer = typeof contenido === "string" ? Buffer.from(contenido) : contenido;
    if (esBinario(buffer)) continue;
    const hallazgos = buscar(buffer.toString("utf8"));
    if (!hallazgos.length) continue;
    const permitido = porRuta.get(ruta);
    if (permitido && hallazgos.length <= permitido.maximo) continue;
    const donde = hallazgos.map((h) => `${h.linea}:${h.columna} (${h.termino})`).join(", ");
    infracciones.push({
      ruta,
      detalle: permitido
        ? `${hallazgos.length} apariciones, más que las ${permitido.maximo} permitidas: ${donde}`
        : `aparece en ${donde}`,
    });
  }
  return infracciones;
}
