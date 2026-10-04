// nexo-sd-monthly-report: informe mensual de cumplimiento del SLA en PDF.
//
// Autenticación: verify_jwt = false (desplegar con --no-verify-jwt) porque la invoca pg_cron
// el día 1 de cada mes con la cabecera x-nexo-cron-secret (= NEXO_CRON_SECRET). La pantalla de
// informes también la llama con el JWT del usuario: la función lo valida con
// nexo_sd_my_context (agente o supervisor de Yago, con MFA aal2) antes de usar la clave de
// servicio.
import "@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import type { ReportData } from "../_shared/report-pdf.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";
import { BUCKET, type CallerContext, handleMonthlyReport, type ReportBackend } from "./handler.ts";

function supabaseBackend(): ReportBackend {
  const admin = adminClient();
  return {
    async listClientOrgs() {
      const { data, error } = await admin
        .from("nexo_sd_organizations")
        .select("id, name")
        .eq("active", true)
        .eq("is_provider", false)
        .order("name");
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ id: string; name: string }>;
    },
    async reportData(period, orgId) {
      const { data, error } = await admin.rpc("nexo_sd_monthly_report_data", {
        p_period: period,
        p_org_id: orgId,
      });
      if (error) throw new Error(error.message);
      return data as ReportData;
    },
    async uploadPdf(path, bytes) {
      const { error } = await admin.storage
        .from(BUCKET)
        .upload(path, new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), {
          contentType: "application/pdf",
          upsert: true,
        });
      if (error) throw new Error(error.message);
    },
    async recordReport(orgId, period, summary, path, generatedBy) {
      const { data, error } = await admin.rpc("nexo_sd_record_monthly_report", {
        p_org_id: orgId,
        p_period: period,
        p_summary: summary,
        p_pdf_path: path,
        p_generated_by: generatedBy,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    async callerContext(authorization) {
      const { data, error } = await userClient(authorization).rpc("nexo_sd_my_context");
      if (error || !data) return null;
      return data as CallerContext;
    },
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405, cors);
  return await handleMonthlyReport(
    req,
    { backend: supabaseBackend(), env: (n) => Deno.env.get(n), now: () => new Date() },
    cors,
  );
});
