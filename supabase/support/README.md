# Mesa de soporte Nexo · Base de datos (Supabase)

Base de datos, reglas de seguridad, motor del SLA y tareas programadas de la mesa de soporte 24x7 con la que Yago cumple el SLA comprometido con cada cliente. La interfaz está en `apps/support-web` y las funciones Edge en `functions/`.

```
supabase/support/
├─ migrations/        8 migraciones SQL (se aplican en orden)
├─ seed.sql           datos de demostración 100 % sintéticos
├─ functions/         funciones Edge nexo-sd-notify, nexo-sd-inbound y nexo-sd-monthly-report
└─ tests/             pruebas SQL (run-local.sh levanta un PostgreSQL 16 desechable)
```

## Proyecto compartido con ANTON.IA 2.0

El proyecto de Supabase también lo usa ANTON.IA 2.0 (objetos `anton2_*` en `public` y el esquema `anton2_private`, con un trigger en `auth.users`). Estas migraciones:

- Crean solo objetos propios: tablas y funciones `nexo_sd_*` en `public`, el esquema `nexo_private`, el bucket `nexo-sd-adjuntos`, políticas `nexo_sd_*`, trabajos de pg_cron `nexo_sd_*` y funciones Edge `nexo-sd-*`.
- No referencian, modifican ni dependen de objetos `anton2_*`; no agregan triggers en `auth.users` ni cambian ajustes de Auth (`auth.users` solo se referencia por clave foránea).
- No usan `ALTER DEFAULT PRIVILEGES` (afectaría objetos de ANTON): los permisos se dan objeto por objeto.
- Habilitan RLS con políticas explícitas en todas las tablas; ninguna tabla ni función es accesible para `anon`.
- Agregan a la publicación `supabase_realtime` solo sus tablas, y en `storage.objects` agregan políticas acotadas al bucket propio, incluidas políticas *restrictive* que impiden que una política permisiva de otro producto abra el bucket. Para los demás buckets la condición es siempre verdadera.

La prueba `tests/09_estructura_proyecto_compartido.sql` verifica estas reglas en el catálogo.

**Ojo:** toda cuenta nueva de Supabase Auth dispara el trigger de ANTON en `auth.users` y le crea un perfil `anton2_user_profiles`. La mesa no puede evitarlo sin tocar ese trigger (está fuera de alcance). Hay que coordinarlo con el equipo de ANTON. La membresía en la mesa es explícita (`nexo_sd_members`): una cuenta sin membresía no ve nada de la mesa.

## Migraciones

| Archivo | Contenido |
|---|---|
| `20261004130000_nexo_sd_esquema_base.sql` | Esquema `nexo_private`, las 16 tablas `nexo_sd_*` con sus restricciones e índices, la configuración (una fila: calendario hábil, MFA, escalamiento y plazos de la Ley 21.663), las políticas SLA por severidad, RLS habilitada y permisos base (nada para `anon`). |
| `20261004130100_nexo_sd_calendario_habil.sql` | Feriados nacionales 2026 y 2027 y aritmética de tiempo hábil: `nexo_private.sd_add_business_minutes(ts, minutos)`, `sd_business_seconds_between`, `sd_calendar_add` y `sd_calendar_seconds` (24x7 o hábil). |
| `20261004130200_nexo_sd_identidad_y_clasificacion.sql` | Funciones de pertenencia para RLS (`sd_is_staff`, `sd_user_org_ids`, `sd_has_org_role`, MFA aal2), clasificación determinista `nexo_private.sd_classify(...)` (igual que `classifySeverity`) y correlativo `SD-AAAA-NNNN`. |
| `20261004130300_nexo_sd_motor_sla.sql` | Relojes (creación, hitos, pausas, recálculo al reclasificar), bandeja de avisos, triggers de tickets, eventos, pausas, accesos remotos, incidentes, turnos, RCA y paquetes, y `nexo_private.sd_tick()`. |
| `20261004130400_nexo_sd_operaciones_rpc.sql` | RPC de la aplicación (pausar, reanudar, acusar pausa, acceso remoto, escalar, reclasificar, cuarentena, aprobar paquete, avisos leídos, directorio, contexto) y del backend (bandeja de salida, canal entrante, datos del informe), y `nexo_sd_sla_summary(periodo)`. |
| `20261004130500_nexo_sd_rls_y_permisos.sql` | Permisos por objeto y columna, y todas las políticas de RLS. |
| `20261004130600_nexo_sd_almacenamiento_realtime.sql` | Bucket privado `nexo-sd-adjuntos` (25 MB, tipos permitidos), políticas de storage que replican la visibilidad de los tickets, y tablas en `supabase_realtime`. |
| `20261004130700_nexo_sd_cron.sql` | pg_cron y pg_net (si están disponibles), invocación de funciones Edge con secretos de Vault y los trabajos `nexo_sd_sla_tick` (cada minuto), `nexo_sd_notify_dispatch` (cada minuto) y `nexo_sd_monthly_report` (día 1, 12:20 UTC). |
| `20261004140000_nexo_sd_cuentas_autorizadas.sql` | Lista de correos autorizados que lee la excepción del trigger de `auth.users` en el proyecto compartido, sin acceso para ningún rol de la API. |
| `20261005090000_nexo_sd_nombres_neutros.sql` | Lleva una base creada con la versión anterior a los nombres neutros (`client_ack_*`, `infraestructura_cliente`, `decision_cliente`): renombra columnas y restricciones, migra motivos y eventos, y recrea las funciones que los usan. **Aplíquela antes de desplegar la aplicación web y las funciones de esta versión.** |

Las migraciones se pueden reaplicar sin error (`if not exists`, `create or replace`, `drop policy if exists`, `on conflict do nothing`); las pruebas las aplican dos veces para comprobarlo.

## Cómo aplicarlas en el proyecto compartido

1. **No use `supabase db push` desde esta carpeta.** El historial de migraciones (`supabase_migrations.schema_migrations`) es compartido con ANTON y la CLI reclamaría por versiones ajenas. Aplíquelas con `psql`, en orden y cada una en una transacción:

   ```bash
   for f in supabase/support/migrations/*.sql; do
     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f "$f" || break
   done
   ```

   (`DATABASE_URL` es la cadena de conexión directa del rol `postgres`.) También se pueden pegar, en orden, en el editor SQL del panel.
2. **Extensiones:** la migración de cron crea `pg_cron` (esquema `pg_catalog`) y `pg_net` (esquema `extensions`) si no existen. En un proyecto compartido conviene confirmarlo antes con el equipo de ANTON (Database → Extensions).
3. **Secretos de Vault** para que pg_cron invoque las funciones (el valor de `nexo_sd_cron_secret` debe ser igual a `NEXO_CRON_SECRET` de las funciones):

   ```sql
   select vault.create_secret('https://<ref>.supabase.co', 'nexo_sd_project_url', 'Mesa de soporte Nexo: URL del proyecto');
   select vault.create_secret('<secreto>', 'nexo_sd_cron_secret', 'Mesa de soporte Nexo: secreto de las funciones invocadas por cron');
   ```

   Sin estos secretos, `sd_tick()` sigue marcando vencimientos y encolando avisos, pero nadie los envía (queda una advertencia en el log de la base de datos).
4. **Funciones Edge:** ver `functions/README.md` (se despliegan con `--no-verify-jwt`).
5. **MFA:** la base de datos exige `aal2` (TOTP verificado) para ver cualquier dato (`nexo_sd_settings.require_mfa = true`). TOTP viene habilitado por omisión en Supabase Auth; esta entrega no cambia ajustes de Auth.
6. **Cuentas y membresías:** en el proyecto compartido, primero autorice el correo (el trigger de `auth.users` de la otra aplicación rechaza los correos que no conoce; ver `compartido/README.md`), luego cree la cuenta en Supabase Auth (panel o API de administración) y por último agréguela a la mesa:

   ```sql
   insert into nexo_private.sd_cuentas_autorizadas (correo) values ('persona@yago.cl') on conflict do nothing;
   ```


   ```sql
   insert into public.nexo_sd_organizations (name, slug, is_provider) values ('Yago', 'yago', true), ('Cliente', 'cliente', false)
   on conflict (slug) do nothing;
   insert into public.nexo_sd_members (user_id, org_id, role, display_name, email, phone_e164, whatsapp_opt_in, voice_opt_in)
   select u.id, o.id, 'agente', 'Nombre Apellido', u.email, '+569XXXXXXXX', true, true
   from auth.users u, public.nexo_sd_organizations o
   where u.email = 'persona@yago.cl' and o.slug = 'yago';
   ```

   Los roles `agente` y `supervisor` solo existen en la organización proveedora (Yago). Los avisos por WhatsApp y voz requieren teléfono y la aceptación del canal (`whatsapp_opt_in`, `voice_opt_in`).
7. **Semilla (opcional, solo demostración):** `seed.sql` crea las organizaciones «Cliente (demo)» y «Yago», tickets de ejemplo, un RCA y un paquete de corrección, y vincula solo las cuentas de demostración `*.demo@*.invalid` que ya existan en Auth (no crea usuarios). Los avisos que genera quedan marcados como simulados.

## Modelo del SLA

| Severidad | Calendario | Acuse | Diagnóstico | Solución o solución temporal |
|---|---|---|---|---|
| S1 | 24x7 | 60 min | 120 min | 240 min |
| S2 | 24x7 | 240 min | 480 min | 1.440 min |
| S3 | Hábil | 8 horas hábiles (480 min) | 3 días hábiles (1.620 min) | 10 días hábiles (5.400 min) |
| S4 | Hábil | 1 día hábil (540 min) | Sin plazo | Sin plazo |

- **Recepción 24x7x365 para todas las severidades.** Calendario hábil: lunes a viernes de 09:00 a 18:00 en America/Santiago, sin los feriados de `nexo_sd_holidays` (1 día hábil = 9 horas). Un plazo que se cumple al cierre vence a las 18:00 de ese día.
- **Severidad determinista:** al crear o reclasificar un ticket, la base de datos calcula la severidad y la regla con `nexo_private.sd_classify` a partir de las cinco respuestas del asistente; el cliente no puede escribir la severidad. Los tickets de correo o WhatsApp sin asistente quedan con severidad provisional (`inbound_provisional_severity`, S1 por omisión: ante la duda se trata como crítica) hasta que un agente los reclasifica.
- **Relojes:** al aceptar un ticket se crean tres relojes (acuse, diagnóstico y solución) que parten en la recepción. Los hitos se marcan al llegar al estado: `acusado` cumple el acuse, `en_diagnostico` el diagnóstico, y `solucion_temporal` o `resuelto` la solución. Un salto de estado marca también los hitos anteriores.
- **Pausas:** solo con motivo tipificado (`infraestructura_cliente`, `red`, `terceros`, `decision_cliente`, `acceso_remoto_pendiente`), justificación, autor, inicio y fin, y acuse opcional de la contraparte del cliente, que puede aceptarla u objetarla. El tiempo en pausa no cuenta: en 24x7 se descuenta el tiempo corrido y en calendario hábil solo los minutos hábiles. Una pausa que empieza cuando el plazo ya venció no lo salva. Hay como máximo una pausa abierta por ticket.
- **Acceso remoto (BT-065):** al solicitarlo, el reloj se pausa solo (`acceso_remoto_pendiente`) hasta que la contraparte lo habilita, lo rechaza o se revoca. Al cerrar la sesión se registra la referencia de la bitácora (`session_log_ref`).
- **`sd_tick()`** (cada minuto): avisa al 50 % del plazo al nivel 1 del turno, al 80 % a los niveles 1 y 2, y al vencer (100 %) marca el incumplimiento y avisa a los niveles 1, 2 y 3. Los S1 sin acuse se escalan al nivel 2 a los 10 minutos y al nivel 3 a los 20, con llamada de voz. Si nadie cubre un nivel, el aviso va a los supervisores. Los avisos no se duplican (`dedup_key`).
- **Cuarentena:** un mensaje de un remitente no registrado queda sin organización y sin relojes. El nivel 1 recibe un aviso; el agente lo acepta (el SLA parte en ese momento) o lo descarta.
- **`nexo_sd_sla_summary('AAAA-MM', org)`:** cumplimiento por severidad y métrica de los relojes iniciados en el mes, con minutos efectivos (sin pausas). Es `SECURITY INVOKER`: cada persona solo agrega lo que su RLS le deja ver.

## Seguridad

| Perfil | Ve | Puede |
|---|---|---|
| Sin membresía, o sin MFA (aal1) | Nada | Nada |
| `reportante` | Tickets aceptados de su organización, eventos públicos, relojes, pausas, informes, RCA publicados, paquetes que salieron de borrador | Crear tickets y comentarios públicos con adjuntos en su organización |
| `contraparte` | Lo mismo, más los incidentes de seguridad de su organización | Lo anterior, más acusar u objetar pausas, habilitar o rechazar accesos remotos, revocarlos y aprobar paquetes de corrección |
| `agente` (Yago) | Todo, incluidas las notas internas y la cuarentena | Cambiar estado, asignar, pausar y reanudar, escalar, reclasificar, notas internas, accesos remotos, incidentes, turnos, RCA y paquetes |
| `supervisor` (Yago) | Todo | Lo del agente, más organizaciones, miembros, configuración, feriados y políticas SLA, y aprobar paquetes (cuatro ojos: nunca uno propio) |

- Las funciones de RLS viven en `nexo_private` (no expuesto por la API) y son `SECURITY DEFINER` con `search_path = ''`. Los triggers `BEFORE` son `SECURITY INVOKER`: validan a quien llama e imponen los valores que la API no puede elegir (fecha de recepción, reportante, canal, severidad y estado inicial).
- Las columnas que la API puede escribir están limitadas con permisos por columna, además de los triggers.
- Adjuntos: `tickets/<ticket>/publico/...` los ve la organización; `tickets/<ticket>/interno/...` solo el personal de Yago. `informes/<org>/...` y `documentos/<org>/...` los ve la organización y los escribe Yago.

## Incidentes de seguridad (Ley 21.663)

Los plazos están en `nexo_sd_settings` y se copian en cada incidente al crearlo: alerta temprana 3 horas y segundo reporte 72 horas desde que se toma conocimiento, e informe final 15 días desde el envío de la alerta temprana. **Verificar con el procedimiento institucional** antes de operar (por ejemplo, el plazo de 24 horas del segundo reporte para operadores de importancia vital). `sd_tick()` avisa al nivel 3 y a supervisión al 50 %, 80 % y 100 % de cada hito pendiente.

## Pruebas locales

```bash
supabase/support/tests/run-local.sh          # todas las pruebas
supabase/support/tests/run-local.sh 06       # solo 06_rls.sql
KEEP_CLUSTER=1 supabase/support/tests/run-local.sh   # deja el clúster arriba para depurar
```

El script usa los binarios de PostgreSQL 16 (`/usr/lib/postgresql/16/bin`, o `PG_BIN`), crea un clúster temporal en el puerto 55432 (`NEXO_TEST_PORT`) con el usuario `postgres` si se ejecuta como root, aplica `tests/stubs/supabase_stubs.sql` (roles de la API, `auth.uid()`/`auth.jwt()`, storage, cron, pg_net, Vault, Realtime y una política amplia de «otro producto» en storage), las migraciones dos veces, la semilla dos veces, y luego cada `tests/NN_*.sql` dentro de una transacción que se revierte. Al terminar, detiene y borra el clúster.

| Prueba | Qué verifica |
|---|---|
| `01_calendario_habil.sql` | Suma y diferencia de minutos hábiles: fines de semana, feriados de 2026 y 2027 (incluido el 17-09-2027 de la Ley 20.983), cambios de horario, inicio fuera de jornada y cierre a las 18:00 |
| `02_clasificacion.sql` | `sd_classify` contra las 32 combinaciones de `tests/fixtures/severity_matrix.json` (la misma matriz que verifica Vitest contra `classifySeverity`) y severidad impuesta en los tickets |
| `03_relojes.sql` | Relojes por severidad, vencimientos hábiles, correlativo, hitos por estado, transiciones y reclasificación |
| `04_pausas.sql` | Pausas corridas y hábiles, pausa tardía, motivos tipificados, acceso remoto con pausa automática y acuse del cliente |
| `05_tick_escalamiento.sql` | `sd_tick()`: avisos al 50, 80 y 100 %, vencimiento, escalamiento de S1 sin acuse (nivel 1, 2 y 3 con voz), plazo hábil, Ley 21.663 y despacho con pg_net |
| `06_rls.sql` | anon sin acceso, MFA obligatorio, aislamiento entre organizaciones, reportante sin cambios de estado, agente con operación completa, storage y la política restrictiva |
| `07_canal_entrante_informes.sql` | Correo y WhatsApp entrantes, cuarentena, bandeja de salida con reintentos y resumen mensual |
| `08_incidentes_parches_rca.sql` | Plazos configurables, aprobación de cuatro ojos y RCA publicados |
| `09_estructura_proyecto_compartido.sql` | Prefijos, RLS y políticas en todas las tablas, nada para anon, `search_path` fijo, sin triggers en `auth.users` y sin referencias a `anton2_*` |

La matriz de severidades se regenera con `pnpm --filter @nexo/shared build && node supabase/support/tests/fixtures/generate-severity-matrix.mjs`.

## Operación

- **Feriados de años siguientes:** insertar filas en `nexo_sd_holidays` (los traslados de las Leyes 19.668, 20.299 y 20.983 se calculan al cargar el año).
- **Ver los trabajos programados:** `select * from cron.job where jobname like 'nexo_sd_%';` y `select * from cron.job_run_details order by start_time desc limit 20;`.
- **Avisos fallidos:** `select * from nexo_sd_notifications where status = 'fallida' order by created_at desc;` (además quedan en la línea de tiempo interna del ticket).
