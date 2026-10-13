// Escribe CHECKSUMS.txt (SHA-256, formato de sha256sum) con todos los archivos de la carpeta de una versión,
// salvo el propio CHECKSUMS.txt y las firmas (*.sigstore.json). El flujo de versión lo corre al final, cuando ya
// están los SBOM de las imágenes y la tabla de vulnerabilidades. Se verifica con: sha256sum -c CHECKSUMS.txt
//
// Uso: node tools/release/sumas.mjs release/<versión>
import { resolve } from "node:path";
import { escribirSumas } from "./lib/sumas.mjs";

if (!process.argv[2]) {
  console.error("Uso: node tools/release/sumas.mjs <carpeta de la versión>");
  process.exit(2);
}
const carpeta = resolve(process.argv[2]);
const archivos = escribirSumas(carpeta);
console.log(`CHECKSUMS.txt: ${archivos.length} archivos en ${carpeta}`);
