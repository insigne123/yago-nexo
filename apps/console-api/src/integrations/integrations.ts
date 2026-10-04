import { connect as tlsConnect } from "node:tls";
import { Injectable } from "@nestjs/common";
import { fetch } from "undici";
import { config } from "../config.js";

/** OpenSearch: analítica del gateway (consumo, errores y latencias). */
@Injectable()
export class OpenSearchService {
  async search<T = unknown>(index: string, body: unknown): Promise<T> {
    const res = await fetch(`${config.opensearchUrl}/${index}/_search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenSearch ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
}

/** Prometheus: consultas instantáneas para métricas de salud y despliegues. */
@Injectable()
export class PrometheusService {
  async query(expr: string): Promise<Array<{ metric: Record<string, string>; value: number }>> {
    const res = await fetch(`${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(expr)}`);
    if (!res.ok) throw new Error(`Prometheus ${res.status}`);
    const body = (await res.json()) as { data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> } };
    return body.data.result.map((r) => ({ metric: r.metric, value: Number(r.value[1]) }));
  }
}

export interface RabbitMessage {
  payload: string;
  payload_encoding: string;
  properties: { headers?: Record<string, unknown>; message_id?: string; content_type?: string };
  redelivered: boolean;
  routing_key: string;
  exchange: string;
}

/** RabbitMQ Management API: lectura de la cola de fallidos y reproceso autorizado (BT-051). */
@Injectable()
export class RabbitService {
  private readonly auth = `Basic ${Buffer.from(`${config.rabbitmq.user}:${config.rabbitmq.password}`).toString("base64")}`;

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${config.rabbitmq.api}${path}`, {
      method,
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`RabbitMQ ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Lee mensajes sin consumirlos (los vuelve a encolar). */
  peek(queue: string, count = 100): Promise<RabbitMessage[]> {
    return this.call("POST", `/queues/%2F/${encodeURIComponent(queue)}/get`, {
      count,
      ackmode: "ack_requeue_true",
      encoding: "auto",
      truncate: 50_000,
    });
  }

  /** Toma un lote de mensajes consumiéndolos (para moverlos). */
  take(queue: string, count = 100): Promise<RabbitMessage[]> {
    return this.call("POST", `/queues/%2F/${encodeURIComponent(queue)}/get`, {
      count,
      ackmode: "ack_requeue_false",
      encoding: "auto",
      truncate: 50_000,
    });
  }

  async publish(exchange: string, routingKey: string, payload: string, headers: Record<string, unknown>): Promise<boolean> {
    const res = await this.call<{ routed: boolean }>("POST", `/exchanges/%2F/${encodeURIComponent(exchange)}/publish`, {
      properties: { headers, content_type: "application/json", delivery_mode: 2 },
      routing_key: routingKey,
      payload,
      payload_encoding: "string",
    });
    return res.routed;
  }

  queueInfo(queue: string): Promise<{ messages: number; consumers: number }> {
    return this.call("GET", `/queues/%2F/${encodeURIComponent(queue)}`);
  }
}

export interface TlsProbeResult {
  canal: string;
  origen: string;
  destino: string;
  protocolo: string;
  versiones: string[];
  cifrado: string;
  verificado: string;
  rechazaTls10?: boolean;
}

/** Sondeo TLS real de cada canal para la matriz criptográfica (BT-028). */
@Injectable()
export class TlsProbeService {
  private probe(host: string, port: number, minVersion: "TLSv1" | "TLSv1.2", maxVersion: "TLSv1" | "TLSv1.3") {
    return new Promise<{ ok: boolean; protocol?: string; cipher?: string }>((resolve) => {
      const socket = tlsConnect({ host, port, servername: host, rejectUnauthorized: false, minVersion, maxVersion, timeout: 4000 }, () => {
        const cipher = socket.getCipher();
        resolve({ ok: true, protocol: socket.getProtocol() ?? undefined, cipher: cipher?.name });
        socket.end();
      });
      socket.on("error", () => resolve({ ok: false }));
      socket.on("timeout", () => {
        socket.destroy();
        resolve({ ok: false });
      });
    });
  }

  async matrix(): Promise<TlsProbeResult[]> {
    const out: TlsProbeResult[] = [];
    for (const p of config.tlsProbes) {
      const modern = await this.probe(p.host, p.port, "TLSv1.2", "TLSv1.3");
      const legacy = await this.probe(p.host, p.port, "TLSv1", "TLSv1");
      out.push({
        canal: p.canal,
        origen: p.descripcion,
        destino: `${p.host}:${p.port}`,
        protocolo: "HTTPS",
        versiones: modern.ok ? [modern.protocol ?? "?"] : [],
        cifrado: modern.cipher ?? "sin conexión",
        verificado: new Date().toISOString(),
        rechazaTls10: !legacy.ok,
      });
    }
    return out;
  }
}
