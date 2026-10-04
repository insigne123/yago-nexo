import { Agent, fetch } from "undici";

/**
 * Acceso al registro de WSO2 (servicio ResourceAdminService). Se usa para la configuración que
 * WSO2 guarda en el registro, como los flujos de aprobación (workflow-extensions.xml).
 */
export class RegistryClient {
  private readonly agent: Agent;

  constructor(
    private readonly baseUrl: string,
    private readonly user: string,
    private readonly password: string,
    insecureTls = false,
  ) {
    this.agent = new Agent({ connect: { rejectUnauthorized: !insecureTls } });
  }

  private async call(action: string, body: string): Promise<string> {
    const envelope = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://services.resource.registry.carbon.wso2.org"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
    const res = await fetch(`${this.baseUrl}/services/ResourceAdminService`, {
      method: "POST",
      dispatcher: this.agent,
      headers: {
        "content-type": "text/xml; charset=UTF-8",
        soapaction: `"urn:${action}"`,
        authorization: `Basic ${Buffer.from(`${this.user}:${this.password}`).toString("base64")}`,
      },
      body: envelope,
    });
    const text = await res.text();
    if (!res.ok || text.includes("<soapenv:Fault>")) throw new Error(`Registro ${action}: ${res.status} ${text.slice(0, 400)}`);
    return text;
  }

  async getText(path: string): Promise<string> {
    const xml = await this.call("getTextContent", `<ser:getTextContent><ser:path>${path}</ser:path></ser:getTextContent>`);
    const m = /<ns:return>([\s\S]*?)<\/ns:return>/.exec(xml);
    return (m?.[1] ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  }

  async putText(path: string, content: string): Promise<void> {
    await this.call(
      "updateTextContent",
      `<ser:updateTextContent><ser:resourcePath>${path}</ser:resourcePath><ser:contentText><![CDATA[${content}]]></ser:contentText></ser:updateTextContent>`,
    );
  }
}

export const WORKFLOW_EXTENSIONS_PATH = "/_system/governance/apimgt/applicationdata/workflow-extensions.xml";
