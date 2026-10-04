/**
 * Ejecuta los casos de aceptación con verificación automática y emite un registro por caso.
 *
 *   pnpm --filter @nexo/aceptacion start                       todos los casos (salvo los de perfiles extra)
 *   CASOS=PA-008,PA-020 pnpm --filter @nexo/aceptacion start   solo esos casos
 *   NEXO_HITO=H1 NEXO_EJECUTOR="Nombre Apellido" NEXO_AMBIENTE="QA (CPD)" …    datos del registro
 *
 * Deja en release/aceptacion/<fecha>/ un JSON, un Markdown y un HTML por registro, la salida completa de cada
 * verificación como evidencia (con su SHA-256), un índice y, si existe la imagen nexo-tools/libreoffice:1, el
 * PDF de cada registro para firmar.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CASOS, type Caso } from "./casos.js";
import { construirRegistro, html, markdown, sha256, type Entorno, type Ejecucion, type Registro } from "./registro.js";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function huellaDirectorio(dir: string): string {
  const archivos: string[] = [];
  const recorrer = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (n === ".env" || n === "node_modules") continue;
      if (statSync(p).isDirectory()) recorrer(p);
      else archivos.push(`${relative(dir, p)}:${sha256(readFileSync(p))}`);
    }
  };
  recorrer(dir);
  return sha256(archivos.join("\n"));
}

function entorno(): Entorno {
  const version = (JSON.parse(readFileSync(join(raiz, "package.json"), "utf8")) as { version: string }).version;
  let commit = "desconocido";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: raiz, encoding: "utf8" }).trim();
  } catch {
    /* sin git */
  }
  const sbom = join(raiz, "release", version, `sbom-nexo-${version}.cdx.json`);
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"], { encoding: "utf8" });
  const contenedores = Object.fromEntries(
    (ps.stdout ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t") as [string, string]),
  );
  return {
    ambiente: process.env.NEXO_AMBIENTE ?? "Laboratorio Yago Nexo (Docker Compose)",
    version: `Yago Nexo ${version}`,
    commit,
    sbomSha256: existsSync(sbom) ? sha256(readFileSync(sbom)) : null,
    configuracionSha256: huellaDirectorio(join(raiz, "deploy/compose")),
    host: hostname(),
    vcpu: cpus().length,
    ramGB: Math.round(totalmem() / 1024 ** 3),
    contenedores,
  };
}

function ejecutar(caso: Caso): Promise<Ejecucion> {
  const inicio = new Date();
  return new Promise((ok) => {
    const p = spawn("bash", ["-lc", `set -a; [ -f deploy/compose/.env ] && . deploy/compose/.env; set +a; ${caso.comando}`], { cwd: raiz });
    let salida = "";
    const tomar = (b: Buffer) => {
      salida += b.toString();
      process.stdout.write(b);
    };
    p.stdout.on("data", tomar);
    p.stderr.on("data", tomar);
    p.on("close", (codigo) => ok({ inicio, fin: new Date(), codigoSalida: codigo ?? 1, salida }));
  });
}

async function main() {
  const elegidos = process.env.CASOS?.split(",").map((s) => s.trim());
  const casos = CASOS.filter((c) => (elegidos ? elegidos.includes(c.id) : !c.perfil));
  if (!casos.length) throw new Error("no hay casos que ejecutar");
  const hito = process.env.NEXO_HITO ?? "LAB";
  const ejecutor = process.env.NEXO_EJECUTOR ?? "Yago (ejecución automática)";
  const e = entorno();
  const dir = join(raiz, "release/aceptacion", new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"));
  mkdirSync(join(dir, "evidencia"), { recursive: true });
  const registros: Registro[] = [];
  for (const [i, caso] of casos.entries()) {
    console.log(`\n[aceptación] ${caso.id} · ${caso.titulo}\n  $ ${caso.comando}`);
    const x = await ejecutar(caso);
    const archivo = `evidencia/${caso.id}-salida.txt`;
    writeFileSync(join(dir, archivo), x.salida);
    const r = construirRegistro({ caso, hito, ejecucionN: 1, correlativo: i + 1, entorno: e, ejecucion: x, evidencia: [{ archivo, sha256: sha256(x.salida) }], ejecutor });
    registros.push(r);
    writeFileSync(join(dir, `${r.numero}.json`), JSON.stringify(r, null, 2) + "\n");
    writeFileSync(join(dir, `${r.numero}.md`), markdown(r));
    writeFileSync(join(dir, `${r.numero}.html`), html(r));
    console.log(`[aceptación] ${caso.id}: ${r.estado} (${r.duracion.segundos} s)`);
  }
  const indice = [
    `# Pruebas de aceptación · ${e.version} (commit ${e.commit})`,
    "",
    `Ambiente: ${e.ambiente} · ${new Date().toISOString()} · ejecutor: ${ejecutor}`,
    "",
    "| Registro | Requisitos | Caso | Estado | Duración (s) |",
    "| --- | --- | --- | --- | --- |",
    ...registros.map((r) => `| ${r.numero} | ${r.requisitos.join(", ")} | ${r.titulo} | ${r.estado} | ${r.duracion.segundos} |`),
    "",
    `Aprobadas ${registros.filter((r) => r.estado === "Aprobada").length} de ${registros.length}.`,
    "",
  ].join("\n");
  writeFileSync(join(dir, "INDICE.md"), indice);
  const imagen = "nexo-tools/libreoffice:1";
  if (spawnSync("docker", ["image", "inspect", imagen]).status === 0) {
    spawnSync("docker", ["run", "--rm", "-v", `${dir}:/w`, imagen, "sh", "-c", "soffice --headless --convert-to pdf:writer_web_pdf_Export *.html >/dev/null 2>&1"], { stdio: "ignore" });
  }
  console.log(`\n${indice}\n[aceptación] registros en ${relative(raiz, dir)}`);
  if (registros.some((r) => r.estado !== "Aprobada")) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
