# Yago Nexo 1.2.0

Fecha de publicación: 13-10-2026. Base: WSO2 API Manager 4.7.0 y WSO2 Micro Integrator 4.6.0. Chart
`nexo-platform` 1.2.0.

## Antes de actualizar desde 1.1.0

- **Mesa de soporte:** aplicar la migración `20261013010000_nexo_sd_avisos_y_llamada_telefonica.sql` antes de
  desplegar la aplicación web y las funciones 1.2.0, y reasignar a un supervisor los turnos de nivel 3 de agentes.
- **Secret `nexo-alertas` (clave `token`, mínimo 16 caracteres).** El chart lo exige para la API de la Consola
  (`secretos.alertas`) y el playbook del CPD lo verifica antes de instalar. Alertmanager debe enviar el mismo
  valor como `Authorization: Bearer` (README del chart, «Alertas hacia la Consola»); sin él, el webhook responde
  401 y la alerta no se registra.
- **Laboratorio:** `make -C deploy/compose env` agrega `NEXO_ALERTS_TOKEN` a un `.env` creado con una versión
  anterior; Compose lo entrega a Alertmanager y a la API como el secreto `nexo_alertas_token`. Las imágenes locales
  de la API y de los motores se etiquetan 1.2.0 (`make -C deploy/compose build`) y la API monta `wso2/apim` para
  incluir `platform.yaml` en la exportación.
- **Base de la Consola:** la API aplica al iniciar la migración `0005_retorno_dos_personas.sql` (tabla de
  solicitudes de retorno).
- **API de la Consola:** se elimina `POST /continuity/failback`. El retorno se pide con
  `POST /continuity/failback/requests` y lo aprueba otra persona con `POST /continuity/failback/requests/{id}/approve`
  (o lo rechaza con `/reject`).
- **RabbitMQ:** la cola `solicitudes.dlq` necesita la política `nexo-fallidos-sin-limite-de-entregas`
  (`delivery-limit` -1). En el laboratorio la aplica `make -C deploy/compose bootstrap`; en otra instalación,
  `rabbitmqctl set_policy --apply-to quorum_queues --priority 10 nexo-fallidos-sin-limite-de-entregas '^solicitudes\.dlq$' '{"delivery-limit":-1}'`.

## Consola Nexo (API)

- **Retorno al sitio principal con dos personas.** Permiso nuevo `continuity:failback:request` (operador y
  aprobador): una persona solicita el retorno con un motivo y otra lo aprueba con `continuity:failback:approve`.
  Quien solicitó no puede aprobar (se compara el usuario y el `sub` del token). La solicitud vence a los
  `NEXO_FAILBACK_REQUEST_TTL_MIN` minutos (30 por omisión) y solo puede haber una pendiente. La solicitud, la
  aprobación, el rechazo y el vencimiento quedan en la auditoría; `GET /continuity` informa la solicitud pendiente.
- **Reproceso de mensajes fallidos con motivo.** Lo hace el rol aprobador, con motivo obligatorio (5 a 1.000
  caracteres) y sin segunda persona; el reproceso y cada rechazo quedan auditados. Las acciones de cuatro ojos
  pasan a ser tres: `rollout:approve`, `anomaly:block:approve` y `continuity:failback:approve`. La matriz tiene 6
  roles y 28 permisos.
- **Auditoría de cada rechazo.** Un 403 por permiso queda como `acceso.rechazado.permiso` (usuario, permiso,
  roles y ruta) y uno por cuatro ojos como `acceso.rechazado.cuatro_ojos`. Los 401 se agrupan por IP
  (`acceso.rechazado.autenticacion`): un evento al primer intento y un resumen con el contador al cerrar la ventana
  (`NEXO_AUDIT_UNAUTHORIZED_WINDOW_SEC`, 60 s), con un tope de IP por ventana (`NEXO_AUDIT_UNAUTHORIZED_MAX_IPS`,
  100). Una escritura que no se completa queda como «rechazado» (4xx) o «error» (5xx).
- **Webhook de alertas con token.** `/api/v1/alerts/alertmanager` exige `Authorization: Bearer` con el token de
  `NEXO_ALERTS_TOKEN` o `NEXO_ALERTS_TOKEN_FILE`, comparado en tiempo constante. Cada alerta recibida queda en la
  auditoría como `alerta.recibida` y llega al SIEM por el reenvío de auditoría existente.
- **Exportación con la configuración de la plataforma.** Si `NEXO_PLATFORM_SPEC` apunta a un `platform.yaml`
  montado (el laboratorio lo monta), el paquete incluye ese archivo y los que referencia (flujos de aprobación y
  guías de estilo) en `plataforma/`, con su SHA-256 en el manifiesto; si no se puede leer, la exportación falla.
- La API informa la versión real del producto (1.2.0) también en el laboratorio, donde antes decía 0.1.0.
- El contrato OpenAPI declara las rutas nuevas y el campo `rechazaTls10` de la matriz de canales TLS.

## Consola Nexo (web) y demostración

- Continuidad: «Solicitar retorno» y la tarjeta de la solicitud pendiente (quién la pidió y cuándo vence);
  «Aprobar» queda deshabilitado para quien la pidió. El RPO de cada conmutación se informa como «no medido».
- Cumplimiento muestra las acciones con motivo obligatorio y si cada canal TLS rechaza TLS 1.0.
- Consumo e Inicio rotulan los errores como «errores 5xx», que es lo que cuenta la API. Auditoría explica qué
  detecta la verificación de la cadena y Exportación describe el contenido real del paquete.
- La versión visible sale del `package.json` de la Consola.
- La demostración no nombra clientes, publica una política de seguridad de contenido (CSP), usa el mismo motor
  de análisis de impacto que la API, presenta los cuatro canales TLS que sondea la API y sigue los pasos reales
  del agente en el simulacro, la conmutación y el retorno con dos personas.

## Motores

- Continuidad: el evento de conmutación ya no registra un RPO de 0 s cuando el rezago de replicación es 0 bytes:
  el RPO en segundos queda sin valor y el rezago en bytes de WAL queda en los pasos y en la auditoría. La auditoría
  del retorno registra quién lo solicitó y quién lo aprobó.

## Integración (Micro Integrator)

- Un rechazo 4xx del sistema de destino ya no se reintenta: va directo a `solicitudes.dlq` con 1 intento y el
  motivo `HTTP 4xx`. Se reintentan (2, 4 y 8 s) las respuestas 5xx, las fallas de red y los tiempos de espera.
- La cola de fallidos queda sin límite de entregas: consultarla no descarta mensajes (comprobado en RabbitMQ
  4.3.6, donde una cola quorum sin la política descartaba el mensaje después de 21 lecturas con rechazo).
- El backend de ejemplo registra cada solicitud recibida (`GET /_recepciones`) y acepta fallas programadas
  (`/_chaos` con `failNext` y `failStatus`), para conciliar mensajes enviados y entregados.

## Observabilidad

- La alerta `ColaConMensajesFallidos` usa la métrica por cola `rabbitmq_detailed_queue_messages_ready` del trabajo
  `rabbitmq-colas`; la regla anterior filtraba por cola en una métrica sin esa etiqueta y nunca se disparaba. Las
  cuatro reglas tienen pruebas unitarias con `promtool test rules` (`deploy/compose/prometheus/pruebas`).
- Diccionario de métricas y alertas generado desde la configuración y el código
  (`deploy/compose/prometheus/diccionario-metricas.md`), con el recorrido de una alerta hasta la auditoría y el
  SIEM; una prueba falla si queda desactualizado.
- El receptor de Alertmanager del laboratorio se llama `consola` y envía el token desde un archivo de secreto.

## Herramientas, verificación y aceptación

- `check:integracion` verifica 8 condiciones y termina con error si alguna no se cumple (202 enriquecido por el
  servicio SOAP, repetición idempotente, 422, entrega única, 4xx sin reintento, cola de fallidos, consulta sin
  pérdida y traza en Jaeger).
- Conciliación de 100 mensajes con 10 fallas 503 del destino, por correlación contra el registro de recepciones
  (`pnpm --filter @nexo/aceptacion conciliacion`, caso PA-009).
- `check:d05` hace el retorno en dos pasos (solicita la operadora y aprueba el aprobador) y `check:consola` verifica
  los rechazos auditados, el retorno con dos personas y el webhook con y sin token.
- `nexo-ctl api export` incluye la configuración de la plataforma (`platform.yaml` y los archivos que referencia)
  en `plataforma/`, con su suma SHA-256 en el manifiesto; `-f` elige otro archivo.
- Respaldo: una restauración con una clave distinta de la del respaldo se rechaza antes de escribir nada
  (`pnpm --filter @nexo/respaldo probar-clave-ajena`, caso PA-053).
- Casos de aceptación nuevos o actualizados: PA-008 (422), PA-009, PA-053 y PA-055 (SBOM, firmas y tabla de
  vulnerabilidades de la versión publicada).
- Banco de preguntas y examen práctico de la certificación al día con estos cambios.

## Instalación (chart nexo-platform 1.2.0)

- El chart sube a `version` y `appVersion` 1.2.0, igual que el producto.
- Todos los contenedores corren con la raíz de solo lectura. Los servidores WSO2 (Control Plane, Traffic
  Manager, Universal Gateways y Micro Integrator) corren sobre una copia escribible de `/home/wso2carbon` en un
  emptyDir, preparada por un contenedor de inicio, y `/tmp` en otro emptyDir (`almacenamiento.hogar` y
  `almacenamiento.temporal` por componente).
- Los `deployment.toml` de WSO2 pasan de ConfigMaps a Secrets (`<componente>-config`): nombran contraseñas y, sin
  `secretos.almacenLlaves.existingSecret`, traen la de los almacenes de ejemplo.
- Los pods de WSO2 corren con el uid de sus imágenes oficiales (10001 en API Manager y 10802 en Micro
  Integrator; valores `apim.uidImagen` y `mi.uidImagen`). Con el uid anterior (802) no podían leer
  `/home/wso2carbon`.
- El esquema de API Manager recibe la contraseña de la base en `PGPASSWORD` directamente desde su Secret.
- La API de la Consola recibe `NEXO_ALERTS_TOKEN` del Secret `nexo-alertas`; el playbook del CPD lo exige.
- `deploy/validar-instaladores.sh` revisa además que ningún contenedor quede sin raíz de solo lectura ni corra
  como root y que ningún `deployment.toml` vuelva a un ConfigMap; con `--solo-helm` valida solo el chart.
- Versiones únicas en instaladores y documentación del despliegue: RKE2 v1.36.5+rke2r1 y PostgreSQL 16.
- La guía de instalación indica que la topología de colas de RabbitMQ (y la política de la cola de fallidos) se
  declara con el servicio de implementación: el chart y el playbook no la crean.

## Mesa de soporte

- **Ticket telefónico con la hora real de la llamada** (`call_received_at`): fija el inicio del reloj, no puede ser
  posterior al registro ni anterior a él en más de `phone_call_max_backdate_minutes` (24 horas por omisión), la API
  no la puede cambiar después y queda en la línea de tiempo con el nombre de quien la ingresó. La aplicación web la
  pide al registrar un ticket telefónico.
- **Aviso a la contraparte cuando vence un plazo** (acuse, diagnóstico o solución): uno solo por vencimiento de
  cada reloj, también con un hito tardío o una reclasificación, registrado en la línea de tiempo interna.
- **Un aviso sin proveedor del canal queda «fallida», no «enviada»**, y se registra en la línea de tiempo interna
  del ticket. Las funciones distinguen esos avisos (`sin_proveedor`).
- **Nivel 3 = supervisión:** los turnos de nivel 3 solo se asignan a supervisores y el aviso al nivel 3 llega solo
  a supervisores.
- Migración `20261013010000_nexo_sd_avisos_y_llamada_telefonica.sql`: se aplica antes de desplegar la aplicación
  web y las funciones 1.2.0; solo toca objetos `nexo_sd_*` y `nexo_private` y se puede reaplicar. Los turnos de
  nivel 3 asignados a agentes antes de la 1.2.0 dejan de recibir avisos y se reasignan a un supervisor
  (consulta en `supabase/support/README.md`).

## Sitio y documentación

- Cada capacidad dice «Incluida en 1.2.0» o «Se entrega con el servicio de implementación (desarrollo
  contratado, con prueba de aceptación)»; el build falla si vuelve un texto de beta o de futuro. La página pasa a
  `/docs/capacidades`, con redirección desde `/docs/hoja-de-ruta`.
- Capacitación al día: 28 permisos, retorno con dos personas, alertas con token, reintentos solo de fallas del
  destino y exportación con la configuración de la plataforma.
- El archivo `NOTICE` separa los componentes incluidos de los que la arquitectura considera y se incorporan con el
  servicio de implementación (OpenMetadata, Argo CD, OpenBao y External Secrets Operator, Microcks y StAEDI).

## Versión firmada, SBOM y vulnerabilidades

- El flujo de versión corre solo desde `main` o desde una etiqueta `v*`, exige el CI en verde en el mismo commit
  y fija todas las acciones por SHA (también en el CI).
- SBOM CycloneDX 1.6 del producto con los componentes propios `@nexo/*`, purls corregidos (`%40` en los scopes de
  npm, imágenes y repositorios correctos) y los componentes de terceros separados en ejecución y desarrollo.
- SBOM de cada imagen con syft (propias y bases de terceros del chart), validados con cyclonedx-cli, firmados y,
  en las propias, atestados en la imagen.
- Tabla de vulnerabilidades de grype en Markdown y JSON, completa, y documento OpenVEX con el estado de cada
  crítica. Verificación de punta a punta: `tools/release/verificar-version.sh 1.2.0` (caso LAB-PA-055-01).
- Guarda de neutralidad en el CI: el repositorio es público y no nombra clientes; el job falla si aparece un
  nombre vetado (sin distinguir mayúsculas).

## CI

- Corrige los dos jobs en rojo de la versión anterior: Trivy (configuración del chart: raíz de solo lectura y
  contraseñas fuera de ConfigMaps) y contratos D-03 (construye las dependencias del workspace antes de validar).
- Nuevos jobs: neutralidad y herramientas de versión; chart de Helm (lint, kubeconform y reglas de seguridad).
- Excepciones de Trivy documentadas una por una en `.trivyignore.yaml` (con plazo cuando corresponde).

## Verificación

```bash
tools/release/verificar-version.sh 1.2.0
```
