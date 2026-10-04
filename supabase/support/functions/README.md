# Funciones Edge de la Mesa de soporte Nexo

Tres funciones Deno para Supabase Edge Functions. Todas usan `@supabase/supabase-js@2` (npm) y los tipos de `jsr:@supabase/functions-js`, y cada una tiene su propio `index.ts` y `deno.json`. El código común está en `_shared/` (Supabase no despliega las carpetas que empiezan con `_`).

| Función | Qué hace | Quién la invoca | Autenticación |
|---|---|---|---|
| `nexo-sd-notify` | Toma los avisos pendientes de `nexo_sd_notifications` y los envía por correo (Resend), WhatsApp Cloud API (plantilla), llamada de voz (Twilio) o aviso en la aplicación (push). Reintenta con espera de 1, 2, 4 y 8 minutos, con un máximo de 5 intentos; los rechazos definitivos (4xx) no se reintentan. | pg_cron cada minuto (`nexo_sd_notify_dispatch`, mediante pg_net), solo si hay avisos pendientes | `verify_jwt = false`, cabecera `x-nexo-cron-secret` = `NEXO_CRON_SECRET` |
| `nexo-sd-inbound` | Webhook de entrada: crea tickets desde correo (JSON genérico o formato Postmark) y desde WhatsApp. Un remitente registrado abre un ticket con severidad provisional; uno desconocido queda en **cuarentena** para revisión de un agente; una respuesta con `SD-AAAA-NNNN` se agrega como comentario. | La pasarela de correo entrante y Meta (WhatsApp Cloud API) | `verify_jwt = false`. WhatsApp: `hub.verify_token` y firma `X-Hub-Signature-256` con `WHATSAPP_APP_SECRET`. Correo: cabecera `x-nexo-inbound-secret` = `NEXO_INBOUND_SECRET` |
| `nexo-sd-monthly-report` | Arma el informe mensual con `nexo_sd_monthly_report_data` (que usa `nexo_sd_sla_summary`), genera el PDF con `pdf-lib`, lo guarda en `nexo-sd-adjuntos/informes/<org>/<AAAA-MM>.pdf` y registra `nexo_sd_monthly_reports`. | pg_cron el día 1 (`nexo_sd_monthly_report`) y la pantalla «Informes mensuales» | `verify_jwt = false`. Cron: `x-nexo-cron-secret`. Aplicación: JWT del usuario, que la función valida con `nexo_sd_my_context` (agente o supervisor con MFA aal2) |

Todas se despliegan con `--no-verify-jwt`: las invocaciones de cron y los webhooks no traen un JWT de Supabase, y cada función valida a quien llama (secreto en tiempo constante, firma HMAC o JWT más membresía).

Si falta la configuración de un proveedor, el aviso queda como `enviada` con `result.simulado = true` y se registra en el log: la función nunca se cae por un proveedor ausente.

## Secretos

Los secretos de Edge Functions son **de todo el proyecto**, que es compartido con ANTON.IA 2.0. Para no pisar ni reutilizar por accidente secretos del otro producto, cada nombre genérico se busca primero con el prefijo `NEXO_SD_` (por ejemplo, `NEXO_SD_RESEND_API_KEY`) y, si no existe, con el nombre genérico (`RESEND_API_KEY`). **En el proyecto compartido use siempre la variante con prefijo.**

| Secreto | Obligatorio | Uso |
|---|---|---|
| `NEXO_CRON_SECRET` | Sí | Secreto compartido de las invocaciones de pg_cron. Debe ser igual al secreto `nexo_sd_cron_secret` de Vault (ver `supabase/support/README.md`). Sin él, notify y monthly-report rechazan todo. |
| `NEXO_INBOUND_SECRET` | Para correo entrante | Valor de la cabecera `x-nexo-inbound-secret` que envía la pasarela de correo. |
| `NEXO_SD_WHATSAPP_VERIFY_TOKEN` (o `WHATSAPP_VERIFY_TOKEN`) | Para WhatsApp entrante | Token de verificación del webhook configurado en Meta. |
| `NEXO_SD_WHATSAPP_APP_SECRET` (o `WHATSAPP_APP_SECRET`) | Para WhatsApp entrante | App Secret de la aplicación de Meta (valida `X-Hub-Signature-256`). |
| `NEXO_SD_WHATSAPP_TOKEN` (o `WHATSAPP_TOKEN`) | Para WhatsApp saliente | Token de acceso de la API de WhatsApp Cloud. |
| `NEXO_SD_WHATSAPP_PHONE_ID` (o `WHATSAPP_PHONE_ID`) | Para WhatsApp saliente | Identificador del número de teléfono emisor. |
| `NEXO_SD_WHATSAPP_TEMPLATE` | No (`nexo_sd_aviso`) | Plantilla aprobada en Meta (categoría *Utility*, idioma `es`) con dos variables en el cuerpo: `{{1}}` aviso y `{{2}}` enlace. |
| `NEXO_SD_WHATSAPP_TEMPLATE_LANG` | No (`es`) | Idioma de la plantilla. |
| `NEXO_SD_WHATSAPP_API_VERSION` | No (`v23.0`) | Versión de la Graph API. Revise que siga vigente. |
| `NEXO_SD_RESEND_API_KEY` (o `RESEND_API_KEY`) | Para correo | Clave de la API de Resend. |
| `NEXO_SD_RESEND_FROM` (o `RESEND_FROM`) | No | Remitente, por omisión `Mesa de soporte Nexo <soporte@yago.cl>` (el dominio debe estar verificado en Resend). |
| `NEXO_SD_TWILIO_ACCOUNT_SID`, `NEXO_SD_TWILIO_AUTH_TOKEN`, `NEXO_SD_TWILIO_FROM_NUMBER` (o `TWILIO_*`) | Para llamadas de voz | Cuenta y número de Twilio. |
| `NEXO_SD_TWILIO_VOICE` | No (`Polly.Mia`) | Voz de Twilio para `<Say language="es-MX">`. |
| `NEXO_ALLOWED_ORIGINS` | No | Orígenes permitidos para CORS en monthly-report, separados por comas (por ejemplo `https://soporte.yago.cl`). |
| `NEXO_NOTIFY_BATCH` | No (25) | Avisos por lote. |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase en cada función.

## Despliegue

La CLI de Supabase busca las funciones en `supabase/functions/`. Como estas viven en `supabase/support/functions/`, se arma una carpeta temporal y se despliega desde ahí (`<ref>` es el identificador del proyecto):

```bash
DEPLOY="$(mktemp -d)"
mkdir -p "$DEPLOY/supabase/functions"
cp -r supabase/support/functions/{_shared,nexo-sd-notify,nexo-sd-inbound,nexo-sd-monthly-report} "$DEPLOY/supabase/functions/"
cd "$DEPLOY"
supabase functions deploy nexo-sd-notify --project-ref <ref> --no-verify-jwt
supabase functions deploy nexo-sd-inbound --project-ref <ref> --no-verify-jwt
supabase functions deploy nexo-sd-monthly-report --project-ref <ref> --no-verify-jwt

supabase secrets set --project-ref <ref> NEXO_CRON_SECRET="$(openssl rand -hex 32)"   # el mismo valor va a Vault
supabase secrets set --project-ref <ref> NEXO_INBOUND_SECRET="$(openssl rand -hex 32)"
# Proveedores (opcionales; sin ellos los avisos quedan simulados):
supabase secrets set --project-ref <ref> NEXO_SD_RESEND_API_KEY=... NEXO_SD_WHATSAPP_TOKEN=... NEXO_SD_WHATSAPP_PHONE_ID=...
```

Webhooks:

- WhatsApp (Meta → Configuración del webhook): `https://<ref>.supabase.co/functions/v1/nexo-sd-inbound/whatsapp`, con el token de verificación `NEXO_SD_WHATSAPP_VERIFY_TOKEN` y suscripción al campo `messages`.
- Correo entrante: la pasarela (Postmark, Resend Inbound u otra) debe hacer `POST https://<ref>.supabase.co/functions/v1/nexo-sd-inbound/email` con la cabecera `x-nexo-inbound-secret` y un JSON con `from`, `subject`, `text` o `html` y `message_id` (también acepta `From`, `Subject`, `TextBody`, `HtmlBody` y `MessageID`).

## Pruebas

```bash
supabase/support/functions/run-checks.sh   # deno check de las tres funciones + deno test (requiere deno)
```

Las pruebas (`tests/*.test.ts`) usan dobles de la base de datos y de `fetch`: verifican la firma de Meta con un vector calculado aparte, el secreto compartido, las plantillas en español, la forma de las llamadas a Resend, WhatsApp y Twilio, el modo simulado, los reintentos, el canal entrante y la generación del PDF.
