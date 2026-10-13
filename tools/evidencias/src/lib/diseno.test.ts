/**
 * Contrato del diseño de 1920×1080 (estudio/index.html y estudio.css) con estudio.js y el motor: si falta un
 * id o una vista, la narradora cae en silencio al modo de compatibilidad o deja un rótulo vacío en el video.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PAQUETE } from "./entorno.js";
import { buscarProhibidos } from "./vigilancia.js";

const html = readFileSync(resolve(PAQUETE, "estudio/index.html"), "utf8");
const css = readFileSync(resolve(PAQUETE, "estudio/estudio.css"), "utf8");
const js = readFileSync(resolve(PAQUETE, "estudio/estudio.js"), "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

describe("diseño de la narradora (V04, V07, V10)", () => {
  it("declara el lienzo de 1920×1080 (sin esto se graba en modo de compatibilidad)", () => {
    expect(html).toMatch(/<body[^>]*data-lienzo="1920x1080"/);
    expect(css).toMatch(/width:\s*1920px/);
    expect(css).toMatch(/height:\s*1080px/);
  });

  it("trae los ids que llenan estudio.js y el motor", () => {
    const necesarios = [
      // banner, chip y firma (V10)
      "banner", "b-producto", "b-chip", "b-nombre", "b-reloj", "b-ambiente", "f-texto",
      // portada (V07)
      "portada", "p-id", "p-nombre", "p-afirmacion", "p-agenda", "p-producto", "p-version-corta", "p-commit", "p-herramientas", "p-fecha", "p-ambiente", "p-capas",
      // escena
      "monitor", "m-url", "m-img", "terminal", "t-titulo", "t-lineas", "panel", "panel-cuerpo",
      // panel lateral (V04)
      "lateral", "l-paso", "l-titulo", "l-que", "l-porque", "l-lista", "l-anterior", "l-anterior-titulo", "l-indicadores", "l-terminal",
      // capítulos y cierre (V07)
      "c-barra", "c-reloj", "resultado", "r-sobretitulo", "r-titulo", "r-resumen", "r-medido", "r-verificaciones", "r-pagina", "r-nota",
    ];
    expect(necesarios.filter((id) => !ids.has(id))).toEqual([]);
    for (const id of necesarios.filter((i) => !["banner", "portada", "monitor", "terminal", "panel", "lateral", "resultado", "m-img"].includes(i))) {
      expect(js, `estudio.js no llena #${id}`).toContain(`"${id}"`);
    }
  });

  it("la imagen operada está dentro del área de pantalla que mide la narradora", () => {
    expect(html).toMatch(/<div class="pantalla"><img id="m-img"/);
  });

  it("cada vista del motor tiene su composición", () => {
    for (const v of ["dividido", "app", "panel", "terminal", "terminal-panel", "panel-completo"]) {
      expect(css, `falta la vista ${v}`).toContain(`body[data-vista="${v}"]`);
    }
    // Todas las vistas con navegador comparten el ancho: la aplicación no se reacomoda a lo ancho.
    const anchos = [...css.matchAll(/body\[data-vista="(?:app|dividido|panel)"\] #monitor \{[^}]*width:\s*(\d+)px/g)].map((m) => m[1]);
    expect(anchos).toHaveLength(3);
    expect(new Set(anchos).size).toBe(1);
  });

  it("el cuerpo del panel lateral se lee a 1080p (≥ 22 px) y las animaciones duran 200–400 ms", () => {
    const tam = (sel: string) => Number(new RegExp(`${sel.replace(/[.#]/g, "\\$&")} \\{[^}]*font-size:\\s*(\\d+)px`).exec(css)?.[1]);
    expect(tam(".bloque p")).toBeGreaterThanOrEqual(22);
    expect(tam("#l-titulo")).toBeGreaterThanOrEqual(26);
    const duraciones = [...css.matchAll(/animation:\s*([a-z-]+)\s+([\d.]+)s/g)].filter((m) => !["latido", "destello"].includes(m[1]!)).map((m) => Number(m[2]));
    expect(duraciones.length).toBeGreaterThan(0);
    for (const d of duraciones) {
      expect(d).toBeGreaterThanOrEqual(0.2);
      expect(d).toBeLessThanOrEqual(0.4);
    }
  });

  it("el rótulo ENSAYO se ve en la firma inferior en modo ensayo", () => {
    expect(css).toMatch(/body\.ensayo #firma::before \{[^}]*content:\s*"ENSAYO"/);
  });

  it("no trae textos prohibidos (vigilancia por huellas, sin escribir los términos)", () => {
    const visible = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ");
    expect(visible).toContain("Yago Nexo");
    expect(buscarProhibidos(`${visible}\n${css}\n${js}`)).toEqual([]);
  });
});
