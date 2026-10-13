import { describe, expect, it } from "vitest";
import { integerInRange, trustProxySetting } from "./env-parse.js";

describe("variables enteras", () => {
  it("acepta enteros dentro del rango", () => {
    expect(integerInRange("NEXO_FAILBACK_REQUEST_TTL_MIN", "30", 1, 1440)).toBe(30);
    expect(integerInRange("NEXO_FAILBACK_REQUEST_TTL_MIN", " 1440 ", 1, 1440)).toBe(1440);
  });

  it("rechaza decimales, ceros, negativos, texto y valores fuera de rango", () => {
    for (const raw of ["0.5", "1.5", "0", "-3", "", "treinta", "1441"])
      expect(() => integerInRange("NEXO_FAILBACK_REQUEST_TTL_MIN", raw, 1, 1440)).toThrow(
        /NEXO_FAILBACK_REQUEST_TTL_MIN debe ser un número entero entre 1 y 1440/,
      );
  });
});

describe("proxies confiables (IP de origen en la auditoría)", () => {
  it("por omisión no se cree a ningún proxy", () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting("")).toBe(false);
    expect(trustProxySetting("false")).toBe(false);
    expect(trustProxySetting("0")).toBe(false);
  });

  it("acepta una cantidad de saltos o una lista de IP y rangos CIDR", () => {
    expect(trustProxySetting("1")).toBe(1);
    expect(trustProxySetting("10.42.0.0/16, 192.0.2.10")).toEqual(["10.42.0.0/16", "192.0.2.10"]);
  });

  it("rechaza «true» y valores que no son IP", () => {
    expect(() => trustProxySetting("true")).toThrow(/cualquier cliente/);
    expect(() => trustProxySetting("ingress")).toThrow(/no es una IP/);
    expect(() => trustProxySetting("11")).toThrow(/entre 1 y 10/);
  });
});
