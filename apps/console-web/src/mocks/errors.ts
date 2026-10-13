/** Error con código HTTP que los manejadores simulados devuelven como cuerpo `Error` del contrato. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly permission?: string,
    /** Motivo de un 409, como en la API (sitio_activo, pendiente_existente, vencida…). */
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }

  toBody(): { statusCode: number; message: string; permission?: string; code?: string; requestId?: string } {
    return {
      statusCode: this.status,
      message: this.message,
      ...(this.permission ? { permission: this.permission } : {}),
      ...(this.code ? { code: this.code } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} no existe.`);
export const conflict = (message: string, code?: string, requestId?: string) =>
  new HttpError(409, message, undefined, code, requestId);
export const badRequest = (message: string) => new HttpError(400, message);
