import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { archivosPlataforma } from "./platform-spec.js";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("configuración de la plataforma en el paquete de exportación de la Consola", () => {
  it("toma wso2/apim/platform.yaml y los archivos que referencia, igual que nexo-ctl api export", () => {
    const archivos = archivosPlataforma(join(raiz, "wso2/apim/platform.yaml"));
    expect(archivos.map((a) => a.ruta)).toEqual([
      "platform.yaml",
      "workflows/workflow-extensions.xml",
      "governance/guia-estilo-institucional.yaml",
    ]);
    for (const a of archivos)
      expect(Buffer.from(a.datos).equals(readFileSync(join(raiz, "wso2/apim", a.ruta))), a.ruta).toBe(true);
  });

  it("falla si la especificación no existe, está vacía o referencia archivos fuera de su carpeta", () => {
    tmp = mkdtempSync(join(tmpdir(), "nexo-plataforma-"));
    expect(() => archivosPlataforma(join(tmp!, "no-existe.yaml"))).toThrow(/ENOENT/);
    mkdirSync(join(tmp, "spec"));
    writeFileSync(join(tmp, "fuera.txt"), "x");
    writeFileSync(
      join(tmp, "spec", "platform.yaml"),
      "governance:\n  rulesets:\n    - name: x\n      file: ../fuera.txt\n",
    );
    expect(() => archivosPlataforma(join(tmp!, "spec", "platform.yaml"))).toThrow(/sale de la carpeta/);
    writeFileSync(join(tmp, "spec", "platform.yaml"), "workflows:\n  file: /etc/passwd\n");
    expect(() => archivosPlataforma(join(tmp!, "spec", "platform.yaml"))).toThrow(/sale de la carpeta/);
    writeFileSync(join(tmp, "spec", "platform.yaml"), "");
    expect(() => archivosPlataforma(join(tmp!, "spec", "platform.yaml"))).toThrow(/no es una especificación/);
  });
});
