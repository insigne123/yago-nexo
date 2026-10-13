/**
 * Registro de lo que el sistema de destino de ejemplo recibe en POST /concesiones, una fila por solicitud HTTP
 * (también las fallas simuladas y las repeticiones). A diferencia de /_estadisticas, que cuenta registros únicos
 * y claves de idempotencia, este registro no deduplica: permite conciliar de punta a punta, por correlación,
 * cuántas veces llegó cada mensaje y con qué resultado (BT-009, BT-051).
 */

export type Resultado = "creado" | "repeticion" | "rechazado" | "falla-simulada";

export interface Recepcion {
  en: string;
  correlacion: string;
  idempotencyKey: string;
  status: number;
  resultado: Resultado;
}

export class Recepciones {
  private readonly filas: Recepcion[] = [];

  constructor(private readonly maximo = 50_000) {}

  registrar(r: Omit<Recepcion, "en">, ahora = new Date()): void {
    this.filas.push({ en: ahora.toISOString(), ...r });
    // Memoria acotada: se descartan las más antiguas.
    if (this.filas.length > this.maximo) this.filas.splice(0, this.filas.length - this.maximo);
  }

  /** Filas filtradas por correlación (lista separada por comas) y por fecha mínima (ISO 8601). */
  consultar(filtro: { correlaciones?: string[]; desde?: string }): Recepcion[] {
    const correlaciones = filtro.correlaciones?.length ? new Set(filtro.correlaciones) : undefined;
    const desde = filtro.desde ? Date.parse(filtro.desde) : undefined;
    if (desde !== undefined && Number.isNaN(desde)) throw new RangeError("desde no es una fecha ISO 8601");
    return this.filas.filter(
      (f) =>
        (!correlaciones || correlaciones.has(f.correlacion)) &&
        (desde === undefined || Date.parse(f.en) >= desde),
    );
  }
}

/**
 * Falla temporal programada: las próximas `restantes` solicitudes POST /concesiones responden `status`
 * (por omisión 503) sin procesarse. Sirve para inyectar una falla acotada y determinista, a diferencia de
 * failRate, que es aleatoria y afecta a todas las rutas.
 */
export class FallaProgramada {
  private restantes = 0;
  private status = 503;

  programar(cantidad: number, status = 503): void {
    if (!Number.isInteger(cantidad) || cantidad < 0)
      throw new RangeError("failNext debe ser un entero mayor o igual a 0");
    if (!Number.isInteger(status) || status < 400 || status > 599)
      throw new RangeError("failStatus debe ser un código HTTP entre 400 y 599");
    this.restantes = cantidad;
    this.status = status;
  }

  /** Devuelve el código con que debe fallar esta solicitud, o undefined si se procesa normalmente. */
  tomar(): number | undefined {
    if (this.restantes <= 0) return undefined;
    this.restantes--;
    return this.status;
  }

  get estado(): { restantes: number; status: number } {
    return { restantes: this.restantes, status: this.status };
  }
}
