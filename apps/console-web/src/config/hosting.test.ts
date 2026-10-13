// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(`${process.cwd()}/${file}`, "utf8");

interface FirebaseHosting {
  hosting: {
    site: string;
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
}

function directives(csp: string): Map<string, string> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name = "", ...values] = d.split(/\s+/);
        return [name, values.join(" ")] as const;
      }),
  );
}

describe("encabezados de seguridad de la demo publicada", () => {
  const hosting = (JSON.parse(read("firebase.json")) as FirebaseHosting).hosting;
  const all = hosting.headers.find((h) => h.source === "**")?.headers ?? [];
  const header = (key: string) => all.find((h) => h.key === key)?.value;

  it("la demo publica una política de seguridad de contenido sin scripts en línea ni orígenes externos", () => {
    const csp = header("Content-Security-Policy");
    expect(csp).toBeDefined();
    const d = directives(csp ?? "");
    expect(d.get("default-src")).toBe("'self'");
    expect(d.get("script-src")).toBe("'self'");
    expect(d.get("connect-src")).toBe("'self'");
    expect(d.get("worker-src")).toBe("'self'"); // el simulador corre en un service worker propio
    expect(d.get("object-src")).toBe("'none'");
    expect(d.get("frame-ancestors")).toBe("'none'");
    expect(csp).not.toMatch(/unsafe-eval|https?:/);
  });

  it("mantiene los demás encabezados de protección", () => {
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header("Permissions-Policy")).toContain("camera=()");
  });

  it("la imagen de la Consola (nginx) aplica la misma política base", () => {
    const nginx = read("nginx.conf");
    const line = nginx.split("\n").find((l) => l.includes("Content-Security-Policy")) ?? "";
    const d = directives(/"([^"]+)"/.exec(line)?.[1] ?? "");
    expect(d.get("script-src")).toBe("'self'");
    expect(d.get("object-src")).toBe("'none'");
  });
});
