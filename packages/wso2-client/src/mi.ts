import type { Agent } from "undici";
import { createAgent, httpRequest, type TlsOptions } from "./http.js";

/**
 * Cliente de la Management API de WSO2 Micro Integrator 4.x (puerto 9164).
 * Lo usan el puente de linaje (lee flujos) y la Consola (colas de mensajes fallidos).
 */
export class MiManagementClient {
  private readonly agent: Agent;
  private token?: string;

  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
    tls?: TlsOptions,
  ) {
    this.agent = createAgent(tls);
  }

  private async auth(): Promise<string> {
    if (this.token) return this.token;
    const res = await httpRequest<{ AccessToken: string }>(this.agent, {
      method: "GET",
      url: `${this.baseUrl}/management/login`,
      headers: { authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}` },
    });
    this.token = res.AccessToken;
    return this.token;
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.auth();
    return httpRequest<T>(this.agent, {
      method: "GET",
      url: `${this.baseUrl}/management${path}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  apis() {
    return this.get<{ count: number; list: Array<{ name: string; url: string; urlList?: string[]; tracing?: string }> }>("/apis");
  }

  api(name: string) {
    return this.get<{ name: string; configuration: string; resources?: unknown[] }>(
      `/apis?apiName=${encodeURIComponent(name)}`,
    );
  }

  endpoints() {
    return this.get<{ count: number; list: Array<{ name: string; type: string; isActive: boolean }> }>("/endpoints");
  }

  endpoint(name: string) {
    return this.get<{ name: string; address?: string; type?: string; isActive?: boolean; configuration?: string }>(
      `/endpoints?endpointName=${encodeURIComponent(name)}`,
    );
  }

  proxyServices() {
    return this.get<{ count: number; list: Array<{ name: string; wsdl1_1?: string; wsdl2_0?: string }> }>(
      "/proxy-services",
    );
  }

  sequences() {
    return this.get<{ count: number; list: Array<{ name: string }> }>("/sequences");
  }

  messageStores() {
    return this.get<{ count: number; list: Array<{ name: string; type: string; size: number }> }>("/message-stores");
  }

  messageProcessors() {
    return this.get<{ count: number; list: Array<{ name: string; type: string; status: string }> }>(
      "/message-processors",
    );
  }

  health() {
    return httpRequest<string>(this.agent, { method: "GET", url: `${this.baseUrl}/management/health`, accept: [503] });
  }
}
