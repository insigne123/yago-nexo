// Lógica de nexo-sd-monthly-report: arma el JSON de cumplimiento (nexo_sd_monthly_report_data,
// que usa nexo_sd_sla_summary), genera el PDF, lo guarda en el bucket y registra el informe.
import { errorMessage, json, log } from "../_shared/http.ts";
import { type ReportData, renderMonthlyReportPdf } from "../_shared/report-pdf.ts";
import { checkSharedSecret } from "../_shared/security.ts";

export const BUCKET = "nexo-sd-adjuntos";

export interface CallerContext {
  user_id: string | null;
  is_staff: boolean;
  mfa_ok: boolean;
}

/** Operaciones de datos que necesita el informe (Supabase en producción, dobles en pruebas). */
export interface ReportBackend {
  listClientOrgs(): Promise<Array<{ id: string; name: string }>>;
  reportData(period: string, orgId: string): Promise<ReportData>;
  uploadPdf(path: string, bytes: Uint8Array): Promise<void>;
  recordReport(
    orgId: string,
    period: string,
    summary: ReportData,
    path: string,
    generatedBy: string | null,
  ): Promise<string>;
  callerContext(authorization: string): Promise<CallerContext | null>;
}

export interface ReportDeps {
  backend: ReportBackend;
  env: (name: string) => string | undefined;
  now: () => Date;
  render?: (data: ReportData) => Promise<Uint8Array>;
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mes anterior al instante dado, en la hora de Santiago (AAAA-MM). */
export function previousPeriod(now: Date, timeZone = "America/Santiago"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
}

export function reportPath(orgId: string, period: string): string {
  return `informes/${orgId}/${period}.pdf`;
}

export async function handleMonthlyReport(
  req: Request,
  deps: ReportDeps,
  cors: Record<string, string> = {},
): Promise<Response> {
  // 1) Quién llama: pg_cron con el secreto compartido, o un agente/supervisor con su JWT (MFA).
  let generatedBy: string | null = null;
  if (req.headers.has("x-nexo-cron-secret")) {
    const check = checkSharedSecret(req, deps.env("NEXO_CRON_SECRET"));
    if (check === "sin_configurar") return json({ error: "Función sin configurar" }, 500, cors);
    if (check !== "ok") return json({ error: "No autorizado" }, 401, cors);
  } else {
    const authorization = req.headers.get("authorization") ?? "";
    if (!authorization.toLowerCase().startsWith("bearer "))
      return json({ error: "No autorizado" }, 401, cors);
    const ctx = await deps.backend.callerContext(authorization);
    if (!ctx || !ctx.user_id) return json({ error: "No autorizado" }, 401, cors);
    if (!ctx.mfa_ok || !ctx.is_staff) {
      return json({ error: "Solo agentes y supervisores de Yago con MFA generan informes" }, 403, cors);
    }
    generatedBy = ctx.user_id;
  }

  // 2) Parámetros: período (por omisión, el mes anterior) y organización (por omisión, todas).
  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return json({ error: "JSON inválido" }, 400, cors);
  }
  const period = String(body["period"] ?? body["periodo"] ?? previousPeriod(deps.now()));
  if (!PERIOD.test(period)) return json({ error: "El período debe tener el formato AAAA-MM" }, 400, cors);
  const orgParam = body["org_id"] ?? body["organizacion_id"];
  if (orgParam !== undefined && (typeof orgParam !== "string" || !UUID.test(orgParam))) {
    return json({ error: "org_id inválido" }, 400, cors);
  }

  const orgs = await deps.backend.listClientOrgs();
  const targets = orgParam ? orgs.filter((o) => o.id === orgParam) : orgs;
  if (orgParam && targets.length === 0)
    return json({ error: "La organización no existe o no es cliente" }, 404, cors);

  // 3) Un informe por organización.
  const render = deps.render ?? renderMonthlyReportPdf;
  const informes: Array<{ org_id: string; organizacion: string; report_id: string; pdf_path: string }> = [];
  const errores: Array<{ org_id: string; error: string }> = [];
  for (const org of targets) {
    try {
      const data = await deps.backend.reportData(period, org.id);
      const bytes = await render(data);
      const path = reportPath(org.id, period);
      await deps.backend.uploadPdf(path, bytes);
      const reportId = await deps.backend.recordReport(org.id, period, data, path, generatedBy);
      informes.push({ org_id: org.id, organizacion: org.name, report_id: reportId, pdf_path: path });
    } catch (err) {
      log("error", "No se pudo generar el informe mensual", {
        org_id: org.id,
        periodo: period,
        error: errorMessage(err),
      });
      errores.push({ org_id: org.id, error: "No se pudo generar el informe" });
    }
  }
  const status = errores.length > 0 && informes.length === 0 ? 500 : 200;
  return json({ periodo: period, informes, errores }, status, cors);
}
