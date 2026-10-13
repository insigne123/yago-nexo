# Diccionario de métricas y alertas de Nexo

<!-- Archivo generado: no se edita a mano. Se regenera con `pnpm --filter @nexo/console-api metricas:diccionario`. -->

Generado desde `deploy/compose/prometheus/prometheus.yml`, `deploy/compose/prometheus/rules/`, `deploy/compose/alertmanager/alertmanager.yml`, `deploy/compose/fluent-bit/fluent-bit.yaml`, `deploy/compose/apim/jmx/config.yaml`, `deploy/compose/grafana/dashboards/` y el código de `services/engines` y `apps/console-api`. Una prueba de `@nexo/console-api` falla si este archivo no coincide con la configuración.

## Recorrido de una alerta

1. Prometheus evalúa las reglas cada 15s (`evaluation_interval`) y envía las alertas activas a Alertmanager; los motores de Nexo envían las suyas directo a Alertmanager (`NEXO_ALERTMANAGER_URL`).
2. Alertmanager las agrupa por `alertname` y `severidad` y el receptor `consola` las entrega, también cuando se resuelven, al webhook de la Consola (`http://console-api:8090/api/v1/alerts/alertmanager`) con el token compartido en `Authorization: Bearer`, leído del archivo de secreto `/run/secrets/nexo_alertas_token`. Sin token o con uno inválido la Consola responde 401 y el intento queda en la auditoría, agrupado por IP.
3. La Consola guarda cada alerta (el resumen de inicio cuenta como abiertas las recibidas en estado `firing` en las últimas 24 h) y la registra en la cadena de auditoría como `alerta.recibida`, con su estado (`firing` o `resolved`), severidad, resumen y etiquetas.
4. El motor `siem` reenvía la cadena de auditoría al SIEM sin pérdida; así cada alerta recibida llega también al SIEM.

## Reglas de alerta de Prometheus

| Alerta | Grupo | Severidad | Duración | Expresión | Resumen | Métricas |
|---|---|---|---|---|---|---|
| ComponenteCaido | nexo-plataforma | S2 | 1m | `up == 0` | {{ $labels.job }} en {{ $labels.instance }} no responde | `up` |
| ColaConMensajesFallidos | nexo-plataforma | S3 | 5m | `sum by (vhost, queue) (rabbitmq_detailed_queue_messages_ready{queue=~".+[.]dlq"}) > 0` | La cola de mensajes fallidos {{ $labels.queue }} tiene {{ $value }} mensajes pendientes | `rabbitmq_detailed_queue_messages_ready` |
| TasaDeErrorAlta | nexo-gateway | S2 | 5m | `100 * sum by (apiName) (rate(nexo_gateway_counter_solicitudes_total{proxyResponseCode=~"5.."}[5m])) / clamp_min(sum by (apiName) (rate(nexo_gateway_counter_solicitudes_total[5m])), 1e-9) > 5` | La API {{ $labels.apiName }} tiene más de 5% de errores 5xx | `nexo_gateway_counter_solicitudes_total` |
| LatenciaAlta | nexo-gateway | S3 | 10m | `histogram_quantile(0.99, sum by (le, apiName) (rate(nexo_gateway_histogram_latencia_ms_bucket[5m]))) > 2000` | La latencia p99 de {{ $labels.apiName }} supera 2 s | `nexo_gateway_histogram_latencia_ms_bucket` |

## Alertas que emiten los motores

| Alerta | Severidad | Motor | Origen |
|---|---|---|---|
| ConmutacionEjecutada | S1 | continuidad | `services/engines/src/continuity/engine.ts` |
| RetornoEjecutado | S2 | continuidad | `services/engines/src/continuity/engine.ts` |
| ApiNoGobernadaRiesgoAlto | S3 | descubrimiento | `services/engines/src/discovery/engine.ts` |
| BloqueoVencido | S4 | guardian | `services/engines/src/guardian/engine.ts` |
| ConsumidorBloqueado | S2 | guardian | `services/engines/src/guardian/engine.ts` |
| AnomaliaDetectada | S3 | guardian | `services/engines/src/guardian/engine.ts` |
| BloqueoPorAprobar | S2 | guardian | `services/engines/src/guardian/engine.ts` |
| DespliegueRevertido | S3 | despliegues | `services/engines/src/rollout/engine.ts` |
| DespliegueDetenido | S4 | despliegues | `services/engines/src/rollout/engine.ts` |
| DespliegueCompletado | S4 | despliegues | `services/engines/src/rollout/engine.ts` |
| SiemRecuperado | S4 | siem | `services/engines/src/siem/engine.ts` |
| SiemSinEntrega | S2 | siem | `services/engines/src/siem/engine.ts` |

## Trabajos de Prometheus

| Trabajo | Destino | Ruta | Componente |
|---|---|---|---|
| prometheus | `localhost:9090` | `/metrics` |  |
| nexo-integrator | `mi:9201` | `/metric-service/metrics` | integrator |
| gateway | `fluent-bit:2021` | `/metrics` | gateway |
| gateway-jvm | `apim:9404` | `/metrics` | gateway |
| fluent-bit | `fluent-bit:2020` | `/api/v2/metrics/prometheus` | observabilidad |
| rabbitmq | `rabbitmq:15692` | `/metrics` | colas |
| rabbitmq-colas | `rabbitmq:15692` | `/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count` | colas |
| keycloak | `keycloak:9000` | `/metrics` | identidad |
| backends | `concesiones-v1:7001`, `concesiones-v2:7001`, `registro-soap:7001` | `/metrics` | backend |
| nexo-services | `console-api:8090` | `/api/v1/metrics` | consola |
| nexo-motores | `motores:9465` | `/metrics` | motores |
| nexo-division | `nexo-division:9902` | `/stats/prometheus` | division |

## Métricas propias de Nexo

| Métrica | Tipo | Etiquetas | Descripción | Trabajo | Origen |
|---|---|---|---|---|---|
| `nexo_consola_*` | proceso |  | Métricas de proceso de Node.js (CPU, memoria, event loop, recolector de basura) con este prefijo | nexo-services | `apps/console-api/src/modules/platform.ts` |
| `nexo_continuidad_sitio` | gauge | sitio, estado | Estado del sitio (1 = sano) por sitio y voto | sin recolección en el laboratorio (motor «continuidad», fuera del servicio motores) | `services/engines/src/continuity/engine.ts` |
| `nexo_descubrimiento_escaneos_total` | counter | resultado | Escaneos ejecutados | nexo-motores | `services/engines/src/discovery/engine.ts` |
| `nexo_descubrimiento_hallazgos` | gauge | estado | Hallazgos por estado | nexo-motores | `services/engines/src/discovery/engine.ts` |
| `nexo_despliegue_pasos_total` | counter | estrategia, tipo | Pasos de despliegue aplicados | nexo-motores | `services/engines/src/rollout/engine.ts` |
| `nexo_despliegue_peso_candidato` | gauge | api | Peso actual del candidato por API | nexo-motores | `services/engines/src/rollout/engine.ts` |
| `nexo_despliegue_reversas_total` | counter | tipo | Reversas automáticas y detenciones manuales | nexo-motores | `services/engines/src/rollout/engine.ts` |
| `nexo_gateway_conexiones_activeconnections` | jmx | transporte | Atributo JMX ActiveConnections (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_conexiones_lastminuterequests` | jmx | transporte | Atributo JMX LastMinuteRequests (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_conexiones_lastsecondrequests` | jmx | transporte | Atributo JMX LastSecondRequests (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_counter_solicitudes_total` | counter | apiName, applicationName, proxyResponseCode, keyType | Solicitudes atendidas por el gateway | gateway | `deploy/compose/fluent-bit/fluent-bit.yaml (log_to_metrics)` |
| `nexo_gateway_histogram_latencia_backend_ms` | histogram | apiName | Latencia del sistema de destino en milisegundos | gateway | `deploy/compose/fluent-bit/fluent-bit.yaml (log_to_metrics, valor backendLatency)` |
| `nexo_gateway_histogram_latencia_ms` | histogram | apiName | Latencia de respuesta del gateway en milisegundos | gateway | `deploy/compose/fluent-bit/fluent-bit.yaml (log_to_metrics, valor responseLatency)` |
| `nexo_gateway_transporte_activethreadcount` | jmx | direccion | Atributo JMX ActiveThreadCount (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_transporte_bytesreceived` | jmx | direccion | Atributo JMX BytesReceived (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_transporte_bytessent` | jmx | direccion | Atributo JMX BytesSent (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_transporte_faultsreceiving` | jmx | direccion | Atributo JMX FaultsReceiving (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_transporte_faultssending` | jmx | direccion | Atributo JMX FaultsSending (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_transporte_lastresettime` | jmx | direccion | Atributo JMX LastResetTime (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_transporte_messagesreceived` | jmx | direccion | Atributo JMX MessagesReceived (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_transporte_messagessent` | jmx | direccion | Atributo JMX MessagesSent (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_transporte_queuesize` | jmx | direccion | Atributo JMX QueueSize (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_transporte_timeoutsreceiving` | jmx | direccion | Atributo JMX TimeoutsReceiving (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_gateway_transporte_timeoutssending` | jmx | direccion | Atributo JMX TimeoutsSending (org.apache.synapse) | gateway-jvm | `deploy/compose/apim/jmx/config.yaml` |
| `nexo_guardian_anomalias_total` | counter | metrica, accion | Anomalías detectadas por métrica y acción | nexo-motores | `services/engines/src/guardian/engine.ts` |
| `nexo_guardian_bloqueos_activos` | gauge |  | Bloqueos activos en el gateway | nexo-motores | `services/engines/src/guardian/engine.ts` |
| `nexo_motor_lider` | gauge | motor | 1 si esta instancia es la líder del motor | nexo-motores | `services/engines/src/kit/runtime.ts` |
| `nexo_motor_ultima_vuelta_timestamp_segundos` | gauge | motor | Momento de la última vuelta exitosa | nexo-motores | `services/engines/src/kit/runtime.ts` |
| `nexo_motor_vuelta_duracion_segundos` | histogram | motor | Duración de cada vuelta | nexo-motores | `services/engines/src/kit/runtime.ts` |
| `nexo_motor_vueltas_total` | counter | motor, resultado | Vueltas de trabajo por motor y resultado | nexo-motores | `services/engines/src/kit/runtime.ts` |
| `nexo_motores_*` | proceso |  | Métricas de proceso de Node.js (CPU, memoria, event loop, recolector de basura) con este prefijo | nexo-motores | `services/engines/src/kit/runtime.ts` |
| `nexo_siem_eventos_enviados_total` | counter | destino | Eventos de auditoría entregados al SIEM | nexo-motores | `services/engines/src/siem/engine.ts` |
| `nexo_siem_fallas_total` | counter | destino | Envíos al SIEM que fallaron (se reintentan) | nexo-motores | `services/engines/src/siem/engine.ts` |
| `nexo_siem_rezago_eventos` | gauge | destino | Eventos de auditoría que aún no llegan al SIEM | nexo-motores | `services/engines/src/siem/engine.ts` |

## Métricas de terceros que usan las reglas y el tablero

| Métrica | Trabajo | Se usa en |
|---|---|---|
| `jvm_memory_max_bytes` | gateway-jvm | tablero «Nexo · Plataforma» · Memoria JVM del gateway |
| `jvm_memory_used_bytes` | gateway-jvm | tablero «Nexo · Plataforma» · Memoria JVM del gateway |
| `rabbitmq_detailed_queue_consumers` | rabbitmq-colas (/metrics/detailed, familia queue_consumer_count) | tablero «Nexo · Plataforma» · Consumidores por cola |
| `rabbitmq_detailed_queue_messages_ready` | rabbitmq-colas (/metrics/detailed, familia queue_coarse_metrics) | regla ColaConMensajesFallidos; tablero «Nexo · Plataforma» · Mensajes en colas |
| `up` | todos los trabajos (Prometheus) | regla ComponenteCaido; tablero «Nexo · Plataforma» · Componentes disponibles (1 = arriba) |
| `wso2_integration_api_request_count_error_total` | nexo-integrator | tablero «Nexo · Plataforma» · Solicitudes al integrador por API |
| `wso2_integration_api_request_count_total` | nexo-integrator | tablero «Nexo · Plataforma» · Solicitudes al integrador por API |

## Paneles del tablero

| Tablero | Panel | Consulta |
|---|---|---|
| Nexo · Plataforma | Solicitudes por segundo | `sum(rate(nexo_gateway_counter_solicitudes_total[5m]))` |
| Nexo · Plataforma | Tasa de error (5xx) | `100 * sum(rate(nexo_gateway_counter_solicitudes_total{proxyResponseCode=~"5.."}[5m])) / clamp_min(sum(rate(nexo_gateway_counter_solicitudes_total[5m])), 1e-9)` |
| Nexo · Plataforma | Rechazos de seguridad (401/403) | `sum(increase(nexo_gateway_counter_solicitudes_total{proxyResponseCode=~"401\|403"}[1h]))` |
| Nexo · Plataforma | Latencia p95 (ms) | `histogram_quantile(0.95, sum by (le) (rate(nexo_gateway_histogram_latencia_ms_bucket[5m])))` |
| Nexo · Plataforma | Solicitudes por segundo por API | `sum by (apiName) (rate(nexo_gateway_counter_solicitudes_total[5m]))` |
| Nexo · Plataforma | Respuestas por código | `sum by (proxyResponseCode) (rate(nexo_gateway_counter_solicitudes_total[5m]))` |
| Nexo · Plataforma | Latencia del gateway por API (p50, p95, p99) | `histogram_quantile(0.50, sum by (le, apiName) (rate(nexo_gateway_histogram_latencia_ms_bucket[5m])))` |
| Nexo · Plataforma | Latencia del gateway por API (p50, p95, p99) | `histogram_quantile(0.95, sum by (le, apiName) (rate(nexo_gateway_histogram_latencia_ms_bucket[5m])))` |
| Nexo · Plataforma | Latencia del gateway por API (p50, p95, p99) | `histogram_quantile(0.99, sum by (le, apiName) (rate(nexo_gateway_histogram_latencia_ms_bucket[5m])))` |
| Nexo · Plataforma | Latencia de los sistemas de destino (p95) | `histogram_quantile(0.95, sum by (le, apiName) (rate(nexo_gateway_histogram_latencia_backend_ms_bucket[5m])))` |
| Nexo · Plataforma | Consumo por aplicación (última hora) | `sum by (applicationName) (increase(nexo_gateway_counter_solicitudes_total[1h]))` |
| Nexo · Plataforma | Componentes disponibles (1 = arriba) | `up` |
| Nexo · Plataforma | Memoria JVM del gateway | `jvm_memory_used_bytes{job="gateway-jvm",area="heap"}` |
| Nexo · Plataforma | Memoria JVM del gateway | `jvm_memory_max_bytes{job="gateway-jvm",area="heap"}` |
| Nexo · Plataforma | Conexiones y cola del transporte | `nexo_gateway_conexiones_activeconnections` |
| Nexo · Plataforma | Conexiones y cola del transporte | `nexo_gateway_transporte_queuesize` |
| Nexo · Plataforma | Conexiones y cola del transporte | `nexo_gateway_transporte_activethreadcount` |
| Nexo · Plataforma | Solicitudes al integrador por API | `sum by (service_name) (rate(wso2_integration_api_request_count_total[5m]))` |
| Nexo · Plataforma | Solicitudes al integrador por API | `sum by (service_name) (rate(wso2_integration_api_request_count_error_total[5m]))` |
| Nexo · Plataforma | Mensajes en colas | `sum by (queue) (rabbitmq_detailed_queue_messages_ready)` |
| Nexo · Plataforma | Consumidores por cola | `sum by (queue) (rabbitmq_detailed_queue_consumers)` |

## Advertencias

Ninguna: toda métrica que usan las reglas y el tablero tiene una fuente en la configuración.
