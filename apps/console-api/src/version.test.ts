import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { versionNexo } from "./version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("versionNexo", () => {
  it("informa la versión del package.json del paquete (no un valor fijo)", () => {
    expect(versionNexo()).toBe(pkg.version);
    expect(versionNexo()).not.toBe("0.1.0");
  });

  it("lee la versión del archivo indicado", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexo-version-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "9.8.7" }));
    expect(versionNexo(pathToFileURL(join(dir, "package.json")))).toBe("9.8.7");
  });

  it("sin package.json legible no inventa una versión", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexo-version-"));
    expect(versionNexo(pathToFileURL(join(dir, "no-existe.json")))).toBe("desconocida");
    writeFileSync(join(dir, "sin-version.json"), JSON.stringify({ name: "x" }));
    expect(versionNexo(pathToFileURL(join(dir, "sin-version.json")))).toBe("desconocida");
  });
});
