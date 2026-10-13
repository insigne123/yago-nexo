import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { archivosPlataforma, escribirPaquete } from "./exportacion.js";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");
let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("paquete de exportación (0-11 e)", () => {
  it("incluye wso2/apim/platform.yaml del repositorio y los archivos que referencia", () => {
    const archivos = archivosPlataforma(join(raiz, "wso2/apim/platform.yaml"));
    expect(archivos.map((a) => a.ruta)).toEqual([
      "platform.yaml",
      "workflows/workflow-extensions.xml",
      "governance/guia-estilo-institucional.yaml",
    ]);
    expect(archivos[0]!.datos.equals(readFileSync(join(raiz, "wso2/apim/platform.yaml")))).toBe(true);
  });

  it("escribe APIs, plataforma y manifiesto con el SHA-256 de cada archivo, legibles sin el repositorio", () => {
    tmp = mkdtempSync(join(tmpdir(), "nexo-export-"));
    const plataforma = archivosPlataforma(join(raiz, "wso2/apim/platform.yaml"));
    const zip = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
    const m = escribirPaquete(
      tmp,
      [{ nombre: "Concesiones", version: "1.0.0", zip }],
      plataforma,
      "https://apim:9443",
      new Date("2026-10-13T00:00:00Z"),
    );
    expect(m.items.map((i) => [i.tipo, i.archivo])).toEqual([
      ["api", "Concesiones-1.0.0.zip"], // gitleaks:allow (nombre de archivo, no es un secreto)
      ["plataforma", "plataforma/platform.yaml"],
      ["plataforma", "plataforma/workflows/workflow-extensions.xml"],
      ["plataforma", "plataforma/governance/guia-estilo-institucional.yaml"],
    ]);
    const leido = JSON.parse(readFileSync(join(tmp, "manifiesto.json"), "utf8")) as typeof m;
    expect(leido).toEqual(m);
    for (const it of leido.items)
      expect(sha(readFileSync(join(tmp, it.archivo))), it.archivo).toBe(it.sha256);
    expect(readFileSync(join(tmp, "plataforma/platform.yaml"), "utf8")).toContain("gatewayEnvironments");
  });

  it("falla si la especificación no existe o si referencia archivos fuera de su carpeta", () => {
    tmp = mkdtempSync(join(tmpdir(), "nexo-export-"));
    expect(() => archivosPlataforma(join(tmp!, "no-existe.yaml"))).toThrow(/ENOENT/);
    mkdirSync(join(tmp, "spec"));
    writeFileSync(join(tmp, "secreto.txt"), "x");
    writeFileSync(join(tmp, "spec", "platform.yaml"), "workflows:\n  file: ../secreto.txt\n");
    expect(() => archivosPlataforma(join(tmp!, "spec", "platform.yaml"))).toThrow(/sale de la carpeta/);
    writeFileSync(join(tmp, "spec", "platform.yaml"), "");
    expect(() => archivosPlataforma(join(tmp!, "spec", "platform.yaml"))).toThrow(/no es una especificación/);
  });
});
