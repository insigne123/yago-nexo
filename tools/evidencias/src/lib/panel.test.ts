import { describe, expect, it } from "vitest";
import { ARRASTRE_MINIMO_MS, ARRASTRE_MS, arrastreAlCerrar, listaComprobaciones, MAX_COMPROBACIONES, normalizar, ordenCierre, recortar, resumenVerificaciones, textoFirma, textoOcultas, type ItemComprobacion } from "./panel.js";

describe("normalizar", () => {
  it("ignora mayúsculas, tildes, comillas, espacios y puntuación final", () => {
    expect(normalizar("  La audiencia quedó en «Operadores».  ")).toBe("la audiencia quedo en operadores");
    expect(normalizar("Escaneo   terminado:")).toBe("escaneo terminado");
  });
});

describe("listaComprobaciones (Se comprueba, V04)", () => {
  const declaradas = ["el campo recibe exactamente lo escrito", "el campo de la clave es de tipo contraseña"];

  it("sin verificaciones, muestra lo declarado como pendiente", () => {
    const l = listaComprobaciones(declaradas, []);
    expect(l.items.map((i) => i.estado)).toEqual(["pendiente", "pendiente"]);
    expect(l.items.map((i) => i.clave)).toEqual(["d0", "d1"]);
    expect(l.ocultasOk + l.ocultasPendientes).toBe(0);
  });

  it("cada verificación en vivo marca su renglón declarado con el valor medido", () => {
    const l = listaComprobaciones(declaradas, [{ texto: "El campo recibe exactamente lo escrito", ok: true, valor: "Concesiones de ensayo" }]);
    expect(l.items[0]).toEqual({ clave: "d0", texto: declaradas[0], estado: "ok", valor: "Concesiones de ensayo" });
    expect(l.items[1]!.estado).toBe("pendiente");
  });

  it("una verificación no declarada se agrega al final, en orden de llegada", () => {
    const l = listaComprobaciones(declaradas, [
      { texto: "no se ve la clave en pantalla", ok: true },
      { texto: declaradas[1]!, ok: false, valor: "type=text" },
    ]);
    expect(l.items.map((i) => [i.clave, i.estado])).toEqual([
      ["d0", "pendiente"],
      ["d1", "mal"],
      ["v0", "ok"],
    ]);
    expect(l.items[2]).not.toHaveProperty("valor");
  });

  it("una verificación que se repite actualiza su renglón y una falla no se borra con un acierto posterior", () => {
    const l = listaComprobaciones([], [
      { texto: "sin errores", ok: false, valor: "3 errores" },
      { texto: "sin errores", ok: true, valor: "0 errores" },
    ]);
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ estado: "mal", valor: "0 errores" });
  });

  it("los valores numéricos se muestran como texto y el vacío no se muestra", () => {
    const l = listaComprobaciones([], [
      { texto: "a", ok: true, valor: 0 },
      { texto: "b", ok: true, valor: "" },
    ]);
    expect(l.items[0]!.valor).toBe("0");
    expect(l.items[1]).not.toHaveProperty("valor");
  });

  it("si no caben, resume primero las cumplidas más antiguas y nunca oculta una ✗", () => {
    const vivas = Array.from({ length: 10 }, (_, i) => ({ texto: `v${i}`, ok: i !== 1 && i !== 2 }));
    const l = listaComprobaciones([], vivas);
    expect(l.items.length + 1).toBe(MAX_COMPROBACIONES);
    expect(l.items.filter((i) => i.estado === "mal").map((i) => i.texto)).toEqual(["v1", "v2"]);
    expect(l.items.at(-1)!.texto).toBe("v9");
    expect(l.ocultasOk).toBe(10 - l.items.length);
    expect(textoOcultas(l)).toBe(`+ ${l.ocultasOk} cumplidas antes ✓`);
  });

  it("con todo fallido muestra todas las ✗ aunque pasen del máximo", () => {
    const l = listaComprobaciones([], Array.from({ length: 9 }, (_, i) => ({ texto: `f${i}`, ok: false })));
    expect(l.items).toHaveLength(9);
    expect(l.ocultasOk + l.ocultasPendientes).toBe(0);
  });
});

describe("recortar", () => {
  const it_ = (clave: string, estado: ItemComprobacion["estado"]): ItemComprobacion => ({ clave, texto: clave, estado });

  it("sin cumplidas que resumir, oculta las pendientes del final", () => {
    const l = recortar([it_("a", "pendiente"), it_("b", "mal"), it_("c", "pendiente"), it_("d", "pendiente")], 3);
    expect(l.items.map((i) => i.clave)).toEqual(["a", "b"]);
    expect(l.ocultasPendientes).toBe(2);
    expect(textoOcultas(l)).toBe("+ 2 más por comprobar");
  });

  it("deja todo si cabe", () => {
    const items = [it_("a", "ok"), it_("b", "pendiente")];
    expect(recortar(items, 2)).toEqual({ items, ocultasOk: 0, ocultasPendientes: 0 });
    expect(textoOcultas({ ocultasOk: 0, ocultasPendientes: 0 })).toBe("");
    expect(textoOcultas({ ocultasOk: 1, ocultasPendientes: 1 })).toBe("+ 1 cumplida antes ✓ · 1 más por comprobar");
  });
});

describe("firma inferior y cierre (V07, V10)", () => {
  it("firma con producto, versión y los dos commits", () => {
    expect(textoFirma({ producto: "Yago Nexo", version: "1.2.0", commitProducto: "abc1234", commitHerramientas: "def5678" })).toBe(
      "Yago Nexo 1.2.0 · commit abc1234 · herramientas def5678",
    );
  });

  it("resumen del cierre", () => {
    expect(resumenVerificaciones([{ ok: true }, { ok: true }]).texto).toBe("✓ 2 de 2 verificaciones cumplidas");
    expect(resumenVerificaciones([{ ok: true }]).texto).toBe("✓ 1 de 1 verificación cumplida");
    expect(resumenVerificaciones([{ ok: true }, { ok: false }, { ok: true }])).toEqual({ cumplidas: 2, total: 3, fallidas: 1, texto: "✗ 1 de 3 verificaciones no se cumplió" });
    expect(resumenVerificaciones([{ ok: false }, { ok: false }]).texto).toBe("✗ 2 de 2 verificaciones no se cumplieron");
    expect(resumenVerificaciones([]).texto).toBe("Sin verificaciones registradas");
  });

  it("en el cierre las fallidas van primero y se conserva el orden", () => {
    const vs = [
      { ok: true, texto: "a" },
      { ok: false, texto: "b" },
      { ok: true, texto: "c" },
      { ok: false, texto: "d" },
    ];
    expect(ordenCierre(vs).map((v) => v.texto)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("arrastreAlCerrar (lo comprobado justo antes de cambiar de paso)", () => {
  const T = 1_000_000;

  it("una verificación recién llegada sigue a la vista en el paso siguiente", () => {
    const a = arrastreAlCerrar(3, [], [{ texto: "canary completado", ok: true, valor: "50 s" }], [T - 500], T);
    expect(a).toEqual({ n: 3, items: [{ clave: "v0", texto: "canary completado", estado: "ok", valor: "50 s" }], hastaMs: T - 500 + ARRASTRE_MS });
  });

  it("lo que llegó hace rato no se arrastra; si todo es antiguo no hay bloque", () => {
    expect(arrastreAlCerrar(1, ["a"], [{ texto: "a", ok: true }], [T - ARRASTRE_MS - 1], T)).toBeUndefined();
    expect(arrastreAlCerrar(1, ["a", "b"], [], [], T)).toBeUndefined();
  });

  it("se ve al menos ARRASTRE_MINIMO_MS aunque haya llegado hace casi toda la ventana", () => {
    const a = arrastreAlCerrar(1, [], [{ texto: "a", ok: true }], [T - ARRASTRE_MS + 100], T)!;
    expect(a.hastaMs).toBe(T + ARRASTRE_MINIMO_MS);
  });

  it("las fallidas van todas, primero y sin plazo (todo el paso siguiente)", () => {
    const vivas = [
      { texto: "f1", ok: false },
      { texto: "a", ok: true },
      { texto: "b", ok: true },
      { texto: "c", ok: true },
      { texto: "d", ok: true },
    ];
    const a = arrastreAlCerrar(2, [], vivas, [T - 60_000, T - 400, T - 300, T - 200, T - 100], T)!;
    expect(a.items.map((i) => i.texto)).toEqual(["f1", "b", "c", "d"]);
    expect(a).not.toHaveProperty("hastaMs");
  });

  it("usa la hora de la última verificación que marcó el renglón declarado", () => {
    const vivas = [
      { texto: "a", ok: true },
      { texto: "A", ok: true, valor: 2 },
    ];
    const a = arrastreAlCerrar(1, ["a"], vivas, [T - 60_000, T - 1000], T)!;
    expect(a.items).toEqual([{ clave: "d0", texto: "a", estado: "ok", valor: "2" }]);
    expect(a.hastaMs).toBe(T - 1000 + ARRASTRE_MS);
  });
});
