// Sumas SHA-256 de los archivos de una versión (formato de sha256sum). Lo usan generar-sbom.mjs y sumas.mjs, y lo
// prueba tools/release/test/sumas.test.mjs.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Escribe <carpeta>/CHECKSUMS.txt con todos los archivos de la carpeta, salvo el propio CHECKSUMS.txt y las
 * firmas (*.sigstore.json). Devuelve los nombres incluidos, en orden. Se verifica con: sha256sum -c CHECKSUMS.txt
 */
export function escribirSumas(carpeta) {
  const archivos = readdirSync(carpeta)
    .filter(
      (f) => f !== "CHECKSUMS.txt" && !f.endsWith(".sigstore.json") && statSync(join(carpeta, f)).isFile(),
    )
    .sort();
  const lineas = archivos.map(
    (f) =>
      `${createHash("sha256")
        .update(readFileSync(join(carpeta, f)))
        .digest("hex")}  ${f}`,
  );
  writeFileSync(join(carpeta, "CHECKSUMS.txt"), lineas.join("\n") + "\n");
  return archivos;
}
