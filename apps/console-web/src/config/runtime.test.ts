import { describe, expect, it, vi } from "vitest";
import { ConfigError, loadRuntimeConfig, parseRuntimeConfig, resolveMockMode } from "./runtime";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const OIDC = {
  apiBaseUrl: "https://api.subtel.invalid/api/v1/",
  environmentLabel: "Producción SUBTEL",
  version: "1.0.0",
  auth: {
    provider: "oidc",
    oidc: { authority: "https://sso.subtel.invalid/realms/nexo", clientId: "nexo-console" },
  },
  demoBanner: false,
};

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("configuración en tiempo de ejecución", () => {
  it("descarga /config.json sin caché y valida el proveedor OIDC", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OIDC));
    const config = await loadRuntimeConfig({ url: "/config.json", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith("/config.json", expect.objectContaining({ cache: "no-store" }));
    expect(config.apiBaseUrl).toBe("https://api.subtel.invalid/api/v1");
    expect(config.auth).toEqual({
      provider: "oidc",
      oidc: {
        authority: "https://sso.subtel.invalid/realms/nexo",
        clientId: "nexo-console",
        rolesClaimPath: "resource_access.nexo-console.roles",
        scope: "openid profile email",
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("aplica valores por defecto", () => {
    const config = parseRuntimeConfig({ auth: { provider: "mock" } });
    expect(config).toEqual({
      apiBaseUrl: "/api/v1",
      environmentLabel: "Laboratorio Yago",
      version: "1.0.0",
      auth: { provider: "mock" },
      demoBanner: false,
    });
  });

  it("valida solo el bloque del proveedor elegido", () => {
    const config = parseRuntimeConfig({
      auth: { provider: "mock", oidc: { authority: "no es una url" }, supabase: 42 },
    });
    expect(config.auth.provider).toBe("mock");
  });

  it("aplica los valores por defecto de Supabase (MFA obligatoria)", () => {
    const config = parseRuntimeConfig({
      auth: { provider: "supabase", supabase: { url: "https://xyz.supabase.co", anonKey: "clave-publica" } },
      demoBanner: true,
    });
    expect(config.auth).toEqual({
      provider: "supabase",
      supabase: {
        url: "https://xyz.supabase.co",
        anonKey: "clave-publica",
        requireMfa: true,
        rolesClaimPath: "app_metadata.roles",
      },
    });
    expect(config.demoBanner).toBe(true);
  });

  it("explica qué campo falta en el proveedor elegido", () => {
    try {
      parseRuntimeConfig({
        auth: { provider: "oidc", oidc: { authority: "https://sso.subtel.invalid/realms/nexo" } },
      });
      expect.unreachable("debió fallar");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).details.some((d) => d.startsWith("auth.oidc.clientId"))).toBe(true);
    }
  });

  it("rechaza un proveedor desconocido", () => {
    expect(() => parseRuntimeConfig({ auth: { provider: "ldap" } })).toThrow(ConfigError);
    try {
      parseRuntimeConfig({ auth: { provider: "ldap" } });
    } catch (error) {
      expect((error as ConfigError).details.join(" ")).toMatch(/auth\.provider/);
    }
  });

  it("informa errores de descarga y de formato", async () => {
    await expect(
      loadRuntimeConfig({ url: "/config.json", fetchImpl: async () => jsonResponse({}, 404) }),
    ).rejects.toThrow("HTTP 404");
    await expect(
      loadRuntimeConfig({ url: "/config.json", fetchImpl: async () => jsonResponse("{no es json") }),
    ).rejects.toThrow("no contiene JSON válido");
    await expect(
      loadRuntimeConfig({
        url: "/config.json",
        fetchImpl: async () => {
          throw new TypeError("network");
        },
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("activa los datos simulados con el proveedor mock o con ?mock=1", () => {
    const storage = memoryStorage();
    const mock = parseRuntimeConfig({ auth: { provider: "mock" } });
    const oidc = parseRuntimeConfig(OIDC);
    expect(resolveMockMode(mock, { search: "" }, storage)).toBe(true);
    expect(resolveMockMode(oidc, { search: "" }, storage)).toBe(false);
    expect(resolveMockMode(oidc, { search: "?mock=1" }, storage)).toBe(true);
    // Se recuerda en la pestaña (la redirección de OIDC pierde la query).
    expect(resolveMockMode(oidc, { search: "?code=abc&state=xyz" }, storage)).toBe(true);
    expect(resolveMockMode(oidc, { search: "?mock=0" }, storage)).toBe(false);
    expect(resolveMockMode(oidc, { search: "" }, storage)).toBe(false);
  });
});
