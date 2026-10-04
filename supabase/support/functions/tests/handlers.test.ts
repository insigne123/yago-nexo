// Pruebas de las tres funciones con dobles de la base de datos (sin red ni Supabase).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { PDFDocument } from "pdf-lib";
import type { RpcClient, RpcResult } from "../_shared/rpc.ts";
import { hmacSha256Hex } from "../_shared/security.ts";
import { formatTarget, type ReportData, renderMonthlyReportPdf, toWinAnsi } from "../_shared/report-pdf.ts";
import { type NotificationRow, processPending } from "../nexo-sd-notify/handler.ts";
import {
  extractWhatsAppMessages,
  handleInbound,
  htmlToText,
  parseAddress,
} from "../nexo-sd-inbound/handler.ts";
import {
  handleMonthlyReport,
  previousPeriod,
  type ReportBackend,
} from "../nexo-sd-monthly-report/handler.ts";

type Call = { fn: string; args: Record<string, unknown> };

function fakeRpc(handler: (fn: string, args: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const client: RpcClient = {
    rpc<T>(fn: string, args: Record<string, unknown> = {}): PromiseLike<RpcResult<T>> {
      calls.push({ fn, args });
      try {
        return Promise.resolve({ data: handler(fn, args) as T, error: null });
      } catch (err) {
        return Promise.resolve({ data: null, error: { message: String(err) } });
      }
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// nexo-sd-notify
// ---------------------------------------------------------------------------
Deno.test("notify: envía, simula y reprograma según el resultado de cada canal", async () => {
  const rows: NotificationRow[] = [
    {
      id: "n1",
      channel: "email",
      recipient: "a@ejemplo.invalid",
      template: "sd_ticket_nuevo",
      payload: { numero: "SD-2026-0001" },
      attempts: 1,
    },
    { id: "n2", channel: "push", recipient: "u1", template: "sd_ticket_nuevo", payload: {}, attempts: 1 },
    {
      id: "n3",
      channel: "whatsapp",
      recipient: "+56900000001",
      template: "sd_sla_vencido",
      payload: {},
      attempts: 1,
    },
    {
      id: "n4",
      channel: "voz",
      recipient: "+56900000001",
      template: "sd_escalamiento_acuse",
      payload: {},
      attempts: 1,
    },
  ];
  let claimed = false;
  const { client, calls } = fakeRpc((fn, args) => {
    if (fn === "nexo_sd_claim_notifications") {
      if (claimed) return [];
      claimed = true;
      return rows;
    }
    if (fn === "nexo_sd_complete_notification") {
      return {
        id: args["p_id"],
        status: args["p_ok"] ? "enviada" : args["p_permanent"] ? "fallida" : "pendiente",
      };
    }
    throw new Error(`RPC inesperada ${fn}`);
  });
  const env: Record<string, string> = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "1" };
  const fetchImpl = ((input: string | URL | Request) =>
    Promise.resolve(
      String(input).includes("graph.facebook.com")
        ? new Response("caído", { status: 503 })
        : new Response("{}", { status: 200 }),
    )) as typeof fetch;

  const summary = await processPending(
    client,
    { env: (k) => env[k], fetch: fetchImpl },
    {
      batch: 10,
      concurrency: 2,
      maxBatches: 3,
      budgetMs: 10_000,
    },
  );
  assertEquals(summary, { procesadas: 4, enviadas: 3, simuladas: 2, reintentos: 1, fallidas: 0 });
  const completes = calls.filter((c) => c.fn === "nexo_sd_complete_notification");
  const byId = Object.fromEntries(completes.map((c) => [c.args["p_id"], c.args]));
  assertEquals(
    (byId["n1"]?.["p_result"] as Record<string, unknown>)["simulado"],
    true,
    "correo sin RESEND_API_KEY",
  );
  assertEquals((byId["n4"]?.["p_result"] as Record<string, unknown>)["simulado"], true, "voz sin Twilio");
  assertEquals(byId["n3"]?.["p_ok"], false);
  assertEquals(byId["n3"]?.["p_permanent"], false, "un 503 se reintenta");
  assertStringIncludes(String(byId["n3"]?.["p_error"]), "HTTP 503");
});

// ---------------------------------------------------------------------------
// nexo-sd-inbound
// ---------------------------------------------------------------------------
const inboundEnv: Record<string, string> = {
  WHATSAPP_VERIFY_TOKEN: "token-verificacion",
  WHATSAPP_APP_SECRET: "secreto-de-app",
  NEXO_INBOUND_SECRET: "secreto-correo",
};

Deno.test("inbound: verificación del webhook de WhatsApp", async () => {
  const { client } = fakeRpc(() => null);
  const ok = await handleInbound(
    new Request(
      "http://x/nexo-sd-inbound/whatsapp?hub.mode=subscribe&hub.verify_token=token-verificacion&hub.challenge=123",
    ),
    { client, env: (k) => inboundEnv[k] },
  );
  assertEquals(ok.status, 200);
  assertEquals(await ok.text(), "123");
  const bad = await handleInbound(
    new Request(
      "http://x/nexo-sd-inbound/whatsapp?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=123",
    ),
    { client, env: (k) => inboundEnv[k] },
  );
  assertEquals(bad.status, 403);
});

const whatsappPayload = {
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ wa_id: "56922222222", profile: { name: "Diego" } }],
            messages: [
              {
                from: "56922222222",
                id: "wamid.A",
                timestamp: "1791234567",
                type: "text",
                text: { body: "Todo caído" },
              },
              {
                from: "56922222222",
                id: "wamid.B",
                timestamp: "1791234568",
                type: "image",
                image: { caption: "error" },
              },
              { from: "56922222222", id: "wamid.C", type: "reaction", reaction: { emoji: "x" } },
            ],
            statuses: [{ id: "wamid.Z", status: "delivered" }],
          },
        },
      ],
    },
  ],
};

Deno.test("inbound: un POST de WhatsApp sin firma válida se rechaza", async () => {
  const { client, calls } = fakeRpc(() => ({ resultado: "ticket" }));
  const res = await handleInbound(
    new Request("http://x/nexo-sd-inbound/whatsapp", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=00" },
      body: JSON.stringify(whatsappPayload),
    }),
    { client, env: (k) => inboundEnv[k] },
  );
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test(
  "inbound: un POST de WhatsApp firmado crea un ticket por mensaje (sin reacciones ni estados)",
  async () => {
    const body = JSON.stringify(whatsappPayload);
    const signature = `sha256=${await hmacSha256Hex("secreto-de-app", body)}`;
    const { client, calls } = fakeRpc(() => ({ resultado: "ticket", numero: "SD-2026-0009" }));
    const res = await handleInbound(
      new Request("http://x/nexo-sd-inbound/whatsapp", {
        method: "POST",
        headers: { "x-hub-signature-256": signature },
        body,
      }),
      { client, env: (k) => inboundEnv[k] },
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).procesados, 2);
    assertEquals(calls.length, 2);
    assertEquals(calls[0]?.args, {
      p_channel: "whatsapp",
      p_sender: "56922222222",
      p_sender_name: "Diego",
      p_subject: null,
      p_body: "Todo caído",
      p_external_id: "wamid.A",
      p_received_at: new Date(1791234567 * 1000).toISOString(),
    });
    assertStringIncludes(String(calls[1]?.args["p_body"]), "[Mensaje de tipo image");
    assertEquals(extractWhatsAppMessages({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] }), []);
  },
);

Deno.test("inbound: el correo exige el secreto compartido", async () => {
  const { client } = fakeRpc(() => ({ resultado: "ticket" }));
  const request = (headers: Record<string, string>) =>
    new Request("http://x/nexo-sd-inbound/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ from: "a@b.cl", subject: "x", text: "y", message_id: "m1" }),
    });
  assertEquals((await handleInbound(request({}), { client, env: (k) => inboundEnv[k] })).status, 401);
  assertEquals(
    (await handleInbound(request({ "x-nexo-inbound-secret": "otro" }), { client, env: (k) => inboundEnv[k] }))
      .status,
    401,
  );
  assertEquals(
    (await handleInbound(request({ "x-nexo-inbound-secret": "otro" }), { client, env: () => undefined }))
      .status,
    500,
  );
});

Deno.test("inbound: un correo válido pasa remitente, asunto y texto a la base de datos", async () => {
  const { client, calls } = fakeRpc(() => ({ resultado: "cuarentena", numero: "SD-2026-0010" }));
  const res = await handleInbound(
    new Request("http://x/nexo-sd-inbound/email", {
      method: "POST",
      headers: { "x-nexo-inbound-secret": "secreto-correo" },
      body: JSON.stringify({
        From: '"Camila Rojas" <Camila.Rojas@Subtel.invalid>',
        Subject: "Re: [SD-2026-0001] Portal",
        HtmlBody: "<p>Hola,</p><p>sigue <b>fallando</b> &amp; lento</p>",
        MessageID: "<abc@mail>",
      }),
    }),
    { client, env: (k) => inboundEnv[k] },
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).resultado, "cuarentena");
  assertEquals(calls[0]?.args["p_sender"], "camila.rojas@subtel.invalid");
  assertEquals(calls[0]?.args["p_sender_name"], "Camila Rojas");
  assertEquals(calls[0]?.args["p_subject"], "Re: [SD-2026-0001] Portal");
  assertEquals(calls[0]?.args["p_body"], "Hola,\n sigue fallando & lento");
  assertEquals(calls[0]?.args["p_external_id"], "<abc@mail>");
  assertEquals(parseAddress("persona@ejemplo.invalid"), { email: "persona@ejemplo.invalid", name: null });
  assertEquals(htmlToText("<style>x{}</style>a<br>b"), "a\nb");
});

// ---------------------------------------------------------------------------
// nexo-sd-monthly-report
// ---------------------------------------------------------------------------
const sampleReport: ReportData = {
  organizacion: { id: "00000000-0000-4000-8000-0000000000aa", nombre: "SUBTEL (demo)" },
  periodo: "2026-09",
  generado_en: "2026-10-01T12:20:00Z",
  resumen: [
    {
      severity: "S1",
      metric: "acuse",
      calendar: "24x7",
      target_minutes: 60,
      total: 2,
      met_on_time: 1,
      breached: 1,
      pending: 0,
      compliance_pct: "50.00",
      avg_effective_minutes: "55.0",
      max_effective_minutes: "80.0",
    },
    {
      severity: "S3",
      metric: "solucion",
      calendar: "habil",
      target_minutes: 5400,
      total: 0,
      met_on_time: 0,
      breached: 0,
      pending: 0,
      compliance_pct: null,
      avg_effective_minutes: null,
      max_effective_minutes: null,
    },
  ],
  tickets: { total: 2, por_severidad: { S1: 2 }, por_estado: { resuelto: 2 } },
  pausas: [{ motivo: "infraestructura_subtel", cantidad: 1, minutos: "10.0", objetadas: 0 }],
  incumplimientos: [
    {
      numero: "SD-2026-0002",
      titulo: "Gateways con errores → revisión ≥ 2 h",
      severidad: "S1",
      metrica: "acuse",
      vencia: "2026-09-20T14:00:00Z",
      cumplido: "2026-09-20T14:30:00Z",
    },
  ],
  incidentes_seguridad: 0,
};

Deno.test("monthly-report: el período por omisión es el mes anterior en hora de Santiago", () => {
  assertEquals(previousPeriod(new Date("2026-10-15T12:00:00Z")), "2026-09");
  assertEquals(previousPeriod(new Date("2027-01-01T12:00:00Z")), "2026-12");
  // 1 de octubre 01:00 UTC todavía es 30 de septiembre en Santiago.
  assertEquals(previousPeriod(new Date("2026-10-01T01:00:00Z")), "2026-08");
});

Deno.test("monthly-report: genera un PDF válido con el resumen", async () => {
  const bytes = await renderMonthlyReportPdf(sampleReport);
  assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  const doc = await PDFDocument.load(bytes);
  assert(doc.getPageCount() >= 1);
  assertEquals(doc.getTitle(), "Informe mensual SLA 2026-09 - SUBTEL (demo)");
  assertEquals(toWinAnsi("Revisión ≥ 2 h → listo"), "Revisión >= 2 h -> listo");
  assertEquals(formatTarget(5400, "habil"), "10 días hábiles");
  assertEquals(formatTarget(480, "habil"), "8 h hábiles");
  assertEquals(formatTarget(240, "24x7"), "4 h");
});

function fakeBackend(ctx: { user_id: string | null; is_staff: boolean; mfa_ok: boolean } | null) {
  const uploads: string[] = [];
  const records: Array<{ orgId: string; period: string; generatedBy: string | null }> = [];
  const backend: ReportBackend = {
    listClientOrgs: () => Promise.resolve([{ id: sampleReport.organizacion.id, name: "SUBTEL (demo)" }]),
    reportData: (period) => Promise.resolve({ ...sampleReport, periodo: period }),
    uploadPdf: (path) => {
      uploads.push(path);
      return Promise.resolve();
    },
    recordReport: (orgId, period, _summary, _path, generatedBy) => {
      records.push({ orgId, period, generatedBy });
      return Promise.resolve("rep-1");
    },
    callerContext: () => Promise.resolve(ctx),
  };
  return { backend, uploads, records };
}

Deno.test("monthly-report: pg_cron genera el informe con el secreto compartido", async () => {
  const { backend, uploads, records } = fakeBackend(null);
  const res = await handleMonthlyReport(
    new Request("http://x", { method: "POST", headers: { "x-nexo-cron-secret": "s" }, body: "{}" }),
    {
      backend,
      env: (k) => (k === "NEXO_CRON_SECRET" ? "s" : undefined),
      now: () => new Date("2026-10-01T12:20:00Z"),
    },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.periodo, "2026-09");
  assertEquals(uploads, [`informes/${sampleReport.organizacion.id}/2026-09.pdf`]);
  assertEquals(records[0]?.generatedBy, null);
});

Deno.test("monthly-report: solo agentes con MFA lo generan desde la aplicación", async () => {
  const run = async (
    ctx: { user_id: string | null; is_staff: boolean; mfa_ok: boolean } | null,
    body = '{"period":"2026-08"}',
  ) => {
    const fake = fakeBackend(ctx);
    const res = await handleMonthlyReport(
      new Request("http://x", { method: "POST", headers: { authorization: "Bearer jwt" }, body }),
      { backend: fake.backend, env: () => undefined, now: () => new Date("2026-10-01T12:20:00Z") },
    );
    return { status: res.status, fake };
  };
  assertEquals((await run(null)).status, 401);
  assertEquals((await run({ user_id: "u", is_staff: false, mfa_ok: true })).status, 403);
  assertEquals((await run({ user_id: "u", is_staff: true, mfa_ok: false })).status, 403);
  const ok = await run({ user_id: "agente", is_staff: true, mfa_ok: true });
  assertEquals(ok.status, 200);
  assertEquals(ok.fake.records[0], {
    orgId: sampleReport.organizacion.id,
    period: "2026-08",
    generatedBy: "agente",
  });
  assertEquals(
    (await run({ user_id: "agente", is_staff: true, mfa_ok: true }, '{"period":"2026-13"}')).status,
    400,
  );
  assertEquals(
    (await run({ user_id: "agente", is_staff: true, mfa_ok: true }, '{"org_id":"no-es-uuid"}')).status,
    400,
  );
  const sinCabecera = await handleMonthlyReport(new Request("http://x", { method: "POST", body: "{}" }), {
    backend: fakeBackend(null).backend,
    env: () => undefined,
    now: () => new Date(),
  });
  assertEquals(sinCabecera.status, 401);
});
