import { describe, expect, it } from "vitest";
import { loadRuntimeConfig, parseRuntimeConfig, RuntimeConfigError } from "./runtime-config";

describe("configuración en tiempo de ejecución (/config.json)", () => {
  it("acepta una configuración completa y pone una etiqueta por omisión", () => {
    const config = parseRuntimeConfig({
      supabaseUrl: "https://abc.supabase.co",
      supabaseAnonKey: "sb_publishable_0123456789abcdef",
    });
    expect(config.environmentLabel).toBe("producción");
  });

  it("detecta los valores de ejemplo del archivo de desarrollo", () => {
    expect(() =>
      parseRuntimeConfig({
        supabaseUrl: "https://TU-PROYECTO.supabase.co",
        supabaseAnonKey: "REEMPLAZAR-CON-LA-CLAVE-PUBLICABLE-DEL-PROYECTO",
        environmentLabel: "desarrollo",
      }),
    ).toThrow(expect.objectContaining({ kind: "pendiente" }));
  });

  it("rechaza URL y claves inválidas", () => {
    expect(() => parseRuntimeConfig({ supabaseUrl: "ftp://x", supabaseAnonKey: "corta" })).toThrow(
      RuntimeConfigError,
    );
  });

  it("informa si no puede leer el archivo", async () => {
    const notFound = (() => Promise.resolve(new Response("", { status: 404 }))) as unknown as typeof fetch;
    await expect(loadRuntimeConfig(notFound)).rejects.toMatchObject({ kind: "no_encontrado" });
    const ok = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            supabaseUrl: "https://abc.supabase.co",
            supabaseAnonKey: "sb_publishable_0123456789abcdef",
            environmentLabel: "demo",
          }),
        ),
      )) as unknown as typeof fetch;
    await expect(loadRuntimeConfig(ok)).resolves.toMatchObject({ environmentLabel: "demo" });
  });
});
