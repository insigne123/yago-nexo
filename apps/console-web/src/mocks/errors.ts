/** Error con código HTTP que los manejadores simulados devuelven como cuerpo `Error` del contrato. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly permission?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }

  toBody(): { statusCode: number; message: string; permission?: string } {
    return {
      statusCode: this.status,
      message: this.message,
      ...(this.permission ? { permission: this.permission } : {}),
    };
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} no existe.`);
export const conflict = (message: string) => new HttpError(409, message);
export const badRequest = (message: string) => new HttpError(400, message);
