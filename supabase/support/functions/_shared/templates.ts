// Textos de los avisos (español de Chile, sin emojis). Las plantillas las elige la base de
// datos (columna template de nexo_sd_notifications) y el contenido viene en payload.

export type Payload = Record<string, unknown>;

export interface RenderedMessage {
  /** Asunto del correo. */
  subject: string;
  /** Cuerpo en texto plano. */
  text: string;
  /** Cuerpo HTML (escapado). */
  html: string;
  /** Versión corta para WhatsApp (parámetro de plantilla, máx. 1024 caracteres). */
  short: string;
  /** Texto para la llamada de voz (sin enlaces). */
  voice: string;
  /** Enlace a la mesa de soporte, si existe. */
  url: string | null;
}

const dateFormatter = new Intl.DateTimeFormat("es-CL", {
  timeZone: "America/Santiago",
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Fecha y hora de Santiago, por ejemplo "lun 05-10-2026, 18:00". */
export function formatDate(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Date)) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateFormatter.format(date).replace(/\//g, "-");
}

function str(payload: Payload, key: string): string {
  const value = payload[key];
  if (value === null || value === undefined) return "";
  return String(value);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

const REMOTE_STATUS: Record<string, string> = {
  habilitado: "habilitado",
  rechazado: "rechazado",
  revocado: "revocado",
  pendiente: "pendiente",
};

export function renderNotification(template: string, payload: Payload): RenderedMessage {
  const numero = str(payload, "numero");
  const severidad = str(payload, "severidad");
  const titulo = str(payload, "titulo");
  const ticket = numero ? `${numero}${severidad ? ` (${severidad})` : ""}` : "";
  const vence = formatDate(payload["vence"]);
  const url = str(payload, "url") || null;

  let headline: string;
  let body: string;
  switch (template) {
    case "sd_ticket_nuevo":
      headline = `Nuevo ticket ${ticket}: ${titulo}`;
      body = `Organización: ${str(payload, "organizacion") || "sin organización"}. Revise el ticket y acuse recibo.`;
      break;
    case "sd_sla_umbral":
      headline = `${ticket} llegó al ${str(payload, "umbral")} % del plazo de ${str(payload, "metrica_texto")}`;
      body = `${titulo}. El plazo vence ${vence}.`;
      break;
    case "sd_sla_vencido":
      headline = `${ticket}: venció el plazo de ${str(payload, "metrica_texto")}`;
      body = `${titulo}. Venció ${vence}. Se avisó a los niveles 1, 2 y 3 del turno.`;
      break;
    case "sd_escalamiento_acuse":
      headline = `${ticket} sin acuse hace ${str(payload, "minutos")} minutos: escalado al nivel ${str(payload, "nivel")}`;
      body = `${titulo}. Acuse recibo de inmediato.`;
      break;
    case "sd_escalamiento_manual":
      headline = `${ticket} escalado al nivel ${str(payload, "nivel")}`;
      body = `Motivo: ${str(payload, "motivo")}. ${titulo}.`;
      break;
    case "sd_ticket_cuarentena":
      headline = `Mensaje en cuarentena de ${str(payload, "remitente") || "un remitente no registrado"}`;
      body = `${titulo}. Revise si corresponde aceptarlo como ticket o descartarlo.`;
      break;
    case "sd_pausa_iniciada":
      headline = `${numero}: el reloj está en pausa por ${str(payload, "motivo")}`;
      body = `Justificación: ${str(payload, "justificacion")}. Revise la pausa y acúsela en la mesa de soporte.`;
      break;
    case "sd_pausa_objetada":
      headline = `${numero}: El cliente objetó una pausa del reloj`;
      body = `Nota de la contraparte: ${str(payload, "nota")}.`;
      break;
    case "sd_acceso_remoto_solicitado":
      headline = `${numero}: Yago solicita acceso remoto`;
      body = `Alcance: ${str(payload, "alcance")}. El reloj queda en pausa hasta que usted lo habilite o lo rechace.`;
      break;
    case "sd_acceso_remoto_resuelto":
      headline = `${numero}: acceso remoto ${REMOTE_STATUS[str(payload, "estado")] ?? str(payload, "estado")}`;
      body = titulo;
      break;
    case "sd_ticket_acusado":
      headline = `Recibimos su ticket ${numero}`;
      body = `${titulo}. Ya lo estamos atendiendo.`;
      break;
    case "sd_ticket_resuelto":
      headline = `El ticket ${numero} fue resuelto`;
      body = `${titulo}. Si el problema persiste, responda indicando el número del ticket.`;
      break;
    case "sd_ticket_asignado":
      headline = `Se le asignó el ticket ${ticket}`;
      body = titulo;
      break;
    case "sd_incidente_seguridad":
      headline = `Incidente de seguridad registrado: ${str(payload, "incidente")}`;
      body = `Ley 21.663: la alerta temprana al CSIRT vence ${vence}.`;
      break;
    case "sd_incidente_plazo":
      headline = `Ley 21.663: ${str(payload, "hito_texto")} al ${str(payload, "umbral")} % del plazo`;
      body = `${str(payload, "incidente")}. Vence ${vence}.`;
      break;
    case "sd_informe_mensual":
      headline = `Informe mensual de cumplimiento del SLA ${str(payload, "periodo")} disponible`;
      body = "Puede descargarlo en la sección Informes mensuales de la mesa de soporte.";
      break;
    default:
      headline = "Aviso de la Mesa de soporte Nexo";
      body = titulo || "Revise la mesa de soporte.";
  }

  const subject = truncate(`[Mesa de soporte Nexo] ${headline}`, 200);
  const text = [
    headline,
    "",
    body,
    "",
    url ? `Ver en la mesa de soporte: ${url}` : "",
    "",
    "Mesa de soporte Nexo · Yago",
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
  const html = [
    '<!doctype html><html lang="es-CL"><body style="font-family:Arial,Helvetica,sans-serif;color:#111827">',
    `<h1 style="font-size:18px">${escapeHtml(headline)}</h1>`,
    `<p>${escapeHtml(body)}</p>`,
    url ? `<p><a href="${escapeHtml(url)}">Ver en la mesa de soporte</a></p>` : "",
    '<p style="color:#6b7280;font-size:12px">Mesa de soporte Nexo · Yago</p>',
    "</body></html>",
  ].join("");
  const short = truncate(`${headline}. ${body}`, 900);
  const voice = truncate(`Mesa de soporte Nexo. ${headline}. ${body}`.replace(/https?:\/\/\S+/g, ""), 600);
  return { subject, text, html, short, voice, url };
}
