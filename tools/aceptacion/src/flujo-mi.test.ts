/**
 * Prueba de contrato sobre la configuración real de Synapse del flujo de solicitudes (wso2/mi/artifacts):
 * solo se reintentan las fallas del destino (5xx, red y tiempo de espera); un rechazo 4xx va directo a la cola
 * de fallidos, sin reintentos (BT-007, BT-008, BT-051).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { conciliar, cumple, type Enviado, type Recepcion } from "./conciliacion.js";
import {
  analizarXml,
  cargarSecuencias,
  coincideCompleta,
  ejecutarSecuencia,
  evaluar,
  type Mensaje,
  type Respuesta,
} from "./synapse.js";

// NEXO_MI_ARTEFACTOS permite correr la misma prueba sobre otra copia de los artefactos (control negativo).
const artefactos =
  process.env.NEXO_MI_ARTEFACTOS ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../wso2/mi/artifacts");
const secuencias = cargarSecuencias(artefactos, [
  "procesar-solicitud",
  "reintentar-solicitud",
  "error-solicitud",
]);

const cuerpo = {
  idSolicitud: "SOL-1",
  idempotencyKey: "k-1",
  correlacion: "urn:uuid:c-1",
  solicitud: { rutEmpresa: "76.086.428-5", servicio: "Internet", region: "Los Lagos" },
};
const entrega = (intentos: string | undefined): Mensaje => ({
  propiedades: {},
  axis2: {},
  transporte: {
    ...(intentos === undefined ? {} : { "x-intentos": intentos }),
    "x-correlacion": "urn:uuid:c-1",
  },
  cuerpo,
});
const colas = (r: ReturnType<typeof ejecutarSecuencia>) =>
  r.llamadas.filter((l) => l.endpoint.startsWith("Cola"));

/**
 * Recorre el ciclo completo de un mensaje como lo hace RabbitMQ: cada cola de reintento lo devuelve a la cola
 * principal con sus encabezados (dead-lettering), hasta que el destino lo acepta o queda en fallidos.
 */
function recorrer(destino: (llamadaN: number) => Respuesta) {
  let encabezados: Record<string, string> = { "x-intentos": "0", "x-correlacion": "urn:uuid:c-1" };
  let llamadasDestino = 0;
  const reintentos: string[] = [];
  for (let vuelta = 0; vuelta < 10; vuelta++) {
    const r = ejecutarSecuencia(
      secuencias,
      "procesar-solicitud",
      { propiedades: {}, axis2: {}, transporte: { ...encabezados }, cuerpo },
      (ep) => {
        expect(ep).toBe("ConcesionesBackendEP");
        return destino(++llamadasDestino);
      },
    );
    const cola = colas(r).at(-1);
    if (!cola) return { final: "entregado" as const, llamadasDestino, reintentos, registros: r.registros };
    if (cola.endpoint === "ColaFallidosEP")
      return {
        final: "fallidos" as const,
        llamadasDestino,
        reintentos,
        encabezados: cola.encabezados,
        registros: r.registros,
      };
    reintentos.push(cola.endpoint);
    encabezados = {
      "x-intentos": cola.encabezados["x-intentos"]!,
      "x-correlacion": cola.encabezados["x-correlacion"]!,
    };
  }
  throw new Error("el mensaje no terminó en 10 vueltas");
}

describe("simulador de Synapse", () => {
  it("evalúa las expresiones XPath que usan las secuencias", () => {
    const m: Mensaje = {
      propiedades: { intentos: "2", vacio: "" },
      axis2: { HTTP_SC: "503" },
      transporte: { "x-intentos": "1" },
      cuerpo: { a: { b: "x" } },
    };
    expect(evaluar("string(number(get-property('intentos')) + 1)", m)).toBe("3");
    expect(evaluar("string(number(get-property('vacio'))) = 'NaN'", m)).toBe(true);
    expect(
      evaluar("number(get-property('intentos')) < 3 and not(get-property('reintentable') = 'false')", m),
    ).toBe(true);
    expect(evaluar("fn:concat('HTTP ', $axis2:HTTP_SC)", m)).toBe("HTTP 503");
    expect(evaluar("$trp:x-intentos", m)).toBe("1");
    expect(evaluar("json-eval($.a.b)", m)).toBe("x");
    expect(() => evaluar("count(//x)", m)).toThrow(/no soportada/);
  });

  it("compara las expresiones regulares con la cadena completa, como Synapse", () => {
    expect(coincideCompleta("5[0-9][0-9]", "503")).toBe(true);
    expect(coincideCompleta("5[0-9][0-9]", "1503")).toBe(false);
    expect(coincideCompleta("1", "11")).toBe(false);
  });

  it("analiza los artefactos y rechaza XML mal formado", () => {
    expect(secuencias.get("procesar-solicitud")!.atributos.onError).toBe("error-solicitud");
    expect(() => analizarXml("<a><b></a>")).toThrow(/mal formado/);
  });
});

describe("flujo de solicitudes: reintentos solo para fallas del destino (0-32)", () => {
  it("una respuesta 2xx se registra como entregada, sin colas", () => {
    for (const status of [200, 201, 202]) {
      const r = ejecutarSecuencia(secuencias, "procesar-solicitud", entrega("0"), () => ({ status }));
      expect(colas(r)).toEqual([]);
      expect(r.registros.map((x) => x.propiedades.etapa)).toContain("7-destino-ok");
    }
  });

  it("los 4xx temporales (408, 425 y 429) se reintentan con espera progresiva", () => {
    for (const status of [408, 425, 429]) {
      const r = ejecutarSecuencia(secuencias, "procesar-solicitud", entrega("0"), () => ({ status }));
      expect(
        colas(r).map((l) => l.endpoint),
        `HTTP ${status}`,
      ).toEqual(["ColaReintento1EP"]);
      expect(r.registros.map((x) => x.propiedades.etapa)).toContain("8-reintento-programado");
    }
    // Si sigue llegando 429 después de los tres reintentos, va a fallidos con el motivo.
    const ultimo = colas(
      ejecutarSecuencia(secuencias, "procesar-solicitud", entrega("3"), () => ({ status: 429 })),
    )[0]!;
    expect(ultimo.endpoint).toBe("ColaFallidosEP");
    expect(ultimo.encabezados["x-motivo"]).toBe("HTTP 429");
  });

  it("ningún otro 4xx se reintenta: va directo a fallidos con 1 intento y el motivo", () => {
    for (let status = 400; status <= 499; status++) {
      if (status === 408 || status === 425 || status === 429) continue;
      const r = ejecutarSecuencia(secuencias, "procesar-solicitud", entrega("0"), () => ({ status }));
      expect(
        colas(r).map((l) => l.endpoint),
        `HTTP ${status}`,
      ).toEqual(["ColaFallidosEP"]);
      expect(colas(r)[0]!.encabezados).toMatchObject({
        "x-intentos": "1",
        "x-motivo": `HTTP ${status}`,
        "x-correlacion": "urn:uuid:c-1",
      });
      const etapas = r.registros.map((x) => x.propiedades.etapa);
      expect(etapas).not.toContain("8-reintento-programado");
      expect(etapas).toContain("9-enviado-a-fallidos");
    }
  });

  it("un 4xx tampoco se reintenta si llega en un reintento (después de un 5xx)", () => {
    const r = ejecutarSecuencia(secuencias, "procesar-solicitud", entrega("1"), () => ({ status: 422 }));
    expect(colas(r).map((l) => l.endpoint)).toEqual(["ColaFallidosEP"]);
    expect(colas(r)[0]!.encabezados["x-intentos"]).toBe("2");
  });

  it("todo 5xx se reintenta con espera progresiva (colas de 2, 4 y 8 s) y luego va a fallidos", () => {
    for (let status = 500; status <= 599; status++) {
      expect(
        ejecutarSecuencia(secuencias, "procesar-solicitud", entrega("0"), () => ({ status })).llamadas.at(-1)!
          .endpoint,
        `HTTP ${status}`,
      ).toBe("ColaReintento1EP");
    }
    const porIntento = ["0", "1", "2", "3"].map(
      (n) =>
        colas(ejecutarSecuencia(secuencias, "procesar-solicitud", entrega(n), () => ({ status: 503 })))[0]!,
    );
    expect(porIntento.map((l) => l.endpoint)).toEqual([
      "ColaReintento1EP",
      "ColaReintento2EP",
      "ColaReintento3EP",
      "ColaFallidosEP",
    ]);
    expect(porIntento.map((l) => l.encabezados["x-intentos"])).toEqual(["1", "2", "3", "4"]);
  });

  it("otras respuestas que no son 2xx ni 5xx (1xx, 3xx) tampoco se reintentan", () => {
    for (const status of [100, 301, 302, 304]) {
      expect(
        colas(ejecutarSecuencia(secuencias, "procesar-solicitud", entrega("0"), () => ({ status }))).map(
          (l) => l.endpoint,
        ),
        `HTTP ${status}`,
      ).toEqual(["ColaFallidosEP"]);
    }
  });

  it("una falla de red o un tiempo de espera se reintenta (secuencia onError)", () => {
    for (const falla of [
      { codigo: "101503", mensaje: "Connection refused" },
      { codigo: "101504", mensaje: "Send timeout" },
    ]) {
      const r = ejecutarSecuencia(secuencias, "procesar-solicitud", entrega("0"), () => ({ falla }));
      expect(colas(r).map((l) => l.endpoint)).toEqual(["ColaReintento1EP"]);
      expect(colas(r)[0]!.encabezados["x-motivo"]).toBe(`ERROR ${falla.codigo}: ${falla.mensaje}`);
    }
  });

  it("un mensaje sin encabezado x-intentos cuenta como primer intento", () => {
    const r = ejecutarSecuencia(secuencias, "procesar-solicitud", entrega(undefined), () => ({
      status: 500,
    }));
    expect(colas(r)[0]).toMatchObject({ endpoint: "ColaReintento1EP", encabezados: { "x-intentos": "1" } });
  });

  it("ciclo completo: un 422 llega a fallidos con 1 llamada al destino; un 500 persistente, con 4", () => {
    const rechazo = recorrer(() => ({ status: 422 }));
    expect(rechazo).toMatchObject({ final: "fallidos", llamadasDestino: 1, reintentos: [] });
    const caido = recorrer(() => ({ status: 500 }));
    expect(caido).toMatchObject({
      final: "fallidos",
      llamadasDestino: 4,
      reintentos: ["ColaReintento1EP", "ColaReintento2EP", "ColaReintento3EP"],
    });
    expect(caido.encabezados?.["x-intentos"]).toBe("4");
  });

  it("ciclo completo: una falla temporal se recupera con un reintento y se entrega", () => {
    const r = recorrer((n) => (n === 1 ? { status: 503 } : { status: 201 }));
    expect(r).toMatchObject({ final: "entregado", llamadasDestino: 2, reintentos: ["ColaReintento1EP"] });
    const red = recorrer((n) =>
      n <= 2 ? { falla: { codigo: "101503", mensaje: "Connection refused" } } : { status: 201 },
    );
    expect(red).toMatchObject({
      final: "entregado",
      llamadasDestino: 3,
      reintentos: ["ColaReintento1EP", "ColaReintento2EP"],
    });
  });
});

describe("contrato de la conciliación (0-31) sobre la configuración real", () => {
  it("100 mensajes con las primeras 10 entregas en 503: 100 entregados, 0 duplicados, 10 recuperados", () => {
    // Destino de ejemplo: falla programada para las 10 primeras solicitudes y registro de idempotencia.
    let fallasRestantes = 10;
    const creados = new Set<string>();
    const recepciones: Recepcion[] = [];
    const destino = (m: Mensaje): Respuesta => {
      const fila = (status: number, resultado: Recepcion["resultado"]) => {
        recepciones.push({
          en: new Date(0).toISOString(),
          correlacion: m.transporte["X-Correlation-ID"]!,
          idempotencyKey: m.transporte["Idempotency-Key"]!,
          status,
          resultado,
        });
        return { status };
      };
      if (fallasRestantes > 0) {
        fallasRestantes--;
        return fila(503, "falla-simulada");
      }
      const k = m.transporte["Idempotency-Key"]!;
      if (creados.has(k)) return fila(201, "repeticion");
      creados.add(k);
      return fila(201, "creado");
    };
    // Cola principal FIFO; lo que va a reintento vuelve después de lo que ya estaba en la cola (TTL de 2 s o más).
    let cola = Array.from({ length: 100 }, (_, i) => ({
      n: i + 1,
      encabezados: { "x-intentos": "0", "x-correlacion": `urn:uuid:c-${i + 1}` },
    }));
    const fallidos: number[] = [];
    for (let ronda = 0; cola.length && ronda < 5; ronda++) {
      const siguiente: typeof cola = [];
      for (const msg of cola) {
        const cuerpoN = {
          ...cuerpo,
          idempotencyKey: `k-${msg.n}`,
          correlacion: msg.encabezados["x-correlacion"],
        };
        const m: Mensaje = {
          propiedades: {},
          axis2: {},
          transporte: { ...msg.encabezados },
          cuerpo: cuerpoN,
        };
        const r = ejecutarSecuencia(secuencias, "procesar-solicitud", m, () => destino(m));
        const c = colas(r).at(-1);
        if (c?.endpoint === "ColaFallidosEP") fallidos.push(msg.n);
        else if (c)
          siguiente.push({
            n: msg.n,
            encabezados: {
              "x-intentos": c.encabezados["x-intentos"]!,
              "x-correlacion": c.encabezados["x-correlacion"]!,
            },
          });
      }
      cola = siguiente;
    }
    const enviados: Enviado[] = Array.from({ length: 100 }, (_, i) => ({
      n: i + 1,
      idempotencyKey: `k-${i + 1}`,
      status: 202,
      correlacion: `urn:uuid:c-${i + 1}`,
    }));
    const c = conciliar(enviados, recepciones);
    expect(fallidos).toEqual([]);
    expect(c).toMatchObject({
      enviados: 100,
      entregados: 100,
      duplicados: 0,
      fallasTemporales: 10,
      recuperados: 10,
    });
    expect(cumple(c, 100, 10)).toEqual({ ok: true, motivos: [] });
  });
});
