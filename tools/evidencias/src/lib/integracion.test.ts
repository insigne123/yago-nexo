import { describe, expect, it } from "vitest";
import { elegirEnOrden, leerArgumentos } from "./cli.js";
import { paginaRedireccionEnsayo } from "./grabador.js";
import { crfDesdeEntorno } from "./video.js";

describe("orden de grabación (grabar respeta el orden pedido)", () => {
  const demos = ["D-01", "D-02", "D-03", "D-04", "D-05", "BT-008"].map((id) => ({ id }));

  it("devuelve las demostraciones en el orden de la línea de comandos, sin repetir", () => {
    const { ids } = leerArgumentos(["d02", "bt8", "d01", "d05", "D-02"]);
    expect(elegirEnOrden(demos, ids).map((d) => d.id)).toEqual(["D-02", "BT-008", "D-01", "D-05"]);
  });

  it("omite los ids desconocidos (grabar.ts los informa aparte)", () => {
    expect(elegirEnOrden(demos, ["D-09", "D-03"]).map((d) => d.id)).toEqual(["D-03"]);
  });
});

describe("redirección del ensayo dentro del navegador", () => {
  it("lleva al destino con meta refresh y location.replace, con el destino escapado", () => {
    const html = paginaRedireccionEnsayo(`https://apim:9443/devportal/apis?a=1&b="2"</script>`);
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain("url=https://apim:9443/devportal/apis?a=1&amp;b=&quot;2&quot;&lt;/script&gt;");
    expect(html).toContain("location.replace(");
    // El destino nunca cierra el <script> de la página.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("EVIDENCIAS_CRF", () => {
  it("acepta enteros de 18 a 26 y si no usa 21", () => {
    expect(crfDesdeEntorno(undefined)).toBe(21);
    expect(crfDesdeEntorno("")).toBe(21);
    expect(crfDesdeEntorno("20")).toBe(20);
    expect(crfDesdeEntorno("30")).toBe(21);
    expect(crfDesdeEntorno("21.5")).toBe(21);
  });
});
