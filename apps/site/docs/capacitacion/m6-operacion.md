---
title: "M6 · Observabilidad, continuidad, soporte e incidentes"
sidebar_label: "M6 · Operación y continuidad"
description: Módulo M6 de la capacitación de Yago Nexo (5 horas). Métricas, tableros, alertas, logs y trazas; auditoría en el SIEM; conmutación entre sitios con quórum; severidades, mesa de soporte e incidentes.
---

import Contacto from '@site/src/components/Contacto';
import EstadoCapacidad from '@site/src/components/EstadoCapacidad';

# M6 · Observabilidad, continuidad, soporte e incidentes

**Duración:** 5 horas · **Sesión:** 7 · **Rutas:** Administración, Integración, Seguridad y Certificación

## Objetivos de aprendizaje

Al terminar el módulo, el participante:

1. Encuentra en tableros, métricas, logs y trazas lo que le pasa a una API.
2. Sigue una alerta desde Prometheus hasta la Consola.
3. Comprueba que la auditoría llega al SIEM completa, en orden y sin duplicados.
4. Explica y observa la conmutación entre sitios con quórum: estado sano, simulacro, conmutación automática con RTO medido y retorno guiado.
5. Clasifica la severidad de un incidente con la regla de Nexo y conoce el proceso de soporte, sus plazos y el análisis de causa raíz.

## Agenda

| Bloque | Tiempo | Contenido |
| --- | --- | --- |
| 1 | 0:00 – 0:30 | Señales de la plataforma: métricas, analítica, logs, trazas, auditoría y alertas. |
| 2 | 0:30 – 1:15 | [Ejercicio 6.1](#ejercicio-6-1): métricas, tableros, logs y trazas. |
| 3 | 1:15 – 1:45 | [Ejercicio 6.2](#ejercicio-6-2): una alerta de punta a punta. |
| — | 1:45 – 2:00 | Pausa. |
| 4 | 2:00 – 3:15 | Continuidad entre sitios. [Ejercicio 6.3](#ejercicio-6-3). |
| — | 3:15 – 3:30 | Pausa. |
| 5 | 3:30 – 4:15 | [Ejercicio 6.4](#ejercicio-6-4): auditoría en el SIEM y severidades. |
| 6 | 4:15 – 4:45 | Soporte e incidentes: mesa de soporte, plazos, pausas, escalamiento y causa raíz. Demostración del instructor. |
| 7 | 4:45 – 5:00 | Cierre y autoevaluación. |

## Conceptos

### Señales de la plataforma

| Señal | Cómo se obtiene en el laboratorio | Dónde se ve |
| --- | --- | --- |
| Analítica del gateway | API Manager en modo log escribe `apim_metrics.log`; Fluent Bit la envía a OpenSearch con buffer en disco | Índice `nexo-apim-metrics-*` (OpenSearch Dashboards, `http://localhost:5601`) |
| Métricas del gateway | Fluent Bit deriva contadores e histogramas de la analítica (`nexo_gateway_counter_solicitudes_total`, `nexo_gateway_histogram_latencia_ms_bucket`) | Prometheus y el tablero «Nexo · Plataforma» de Grafana |
| Métricas de componentes | Prometheus recolecta Micro Integrator, RabbitMQ, Keycloak, JVM del gateway, Consola, motores, `nexo-division` y backends | Prometheus (`http://localhost:9090`) |
| Logs de servidor y auditoría de WSO2 | Fluent Bit | Índices `nexo-logs-*` y `nexo-audit-*` |
| Trazas | Gateway e integrador por OTLP al colector, que las entrega a Jaeger | Jaeger (`http://localhost:16686`) |
| Auditoría de Nexo | El motor de reenvío envía la cadena por syslog (RFC 5424) al SIEM; en el laboratorio el SIEM es Fluent Bit hacia OpenSearch | Índice `nexo-siem-*` |

Estados: <EstadoCapacidad id="tableros" conNombre /> · <EstadoCapacidad id="trazas-otel" conNombre /> · <EstadoCapacidad id="auditoria-centralizada" conNombre />

### Alertas

| Alerta | Condición | Severidad |
| --- | --- | --- |
| `ComponenteCaido` | Un destino de Prometheus no responde durante 1 minuto | S2 |
| `TasaDeErrorAlta` | Más de 5 % de respuestas 5xx de una API durante 5 minutos | S2 |
| `LatenciaAlta` | p99 de una API sobre 2 s durante 10 minutos | S3 |
| `ColaConMensajesFallidos` | La cola de fallidos tiene mensajes durante 5 minutos | S3 |

Alertmanager agrupa las alertas y las envía al webhook de la Consola (`/api/v1/alerts/alertmanager`); en producción van a la mesa de soporte y al SIEM.

### Continuidad entre sitios

Un agente en el CPD, otro en Google Cloud y un testigo revisan la salud del sitio principal y votan. **Solo se conmuta con 2 de 3 votos** (<EstadoCapacidad id="motor-continuidad" />). En el laboratorio de continuidad (perfil `cont`):

- `cont-cpd` es el PostgreSQL primario y `cont-gcp` su réplica por streaming; `cont-etcd` guarda los votos y el registro DNS que sirve `cont-coredns` para `activo.nexo.lab` (10.80.0.1 para el CPD, 10.80.0.2 para GCP).
- **Simulacro** (operador): no disruptivo; el agente de respaldo mide el rezago de la réplica y confirma que es promovible, sin promoverla.
- **Conmutación automática**: con quórum, el agente de respaldo promueve la réplica, cambia el DNS y registra el RTO medido.
- **Retorno guiado**: la vuelta al CPD la aprueba una persona con rol aprobador.

En producción la conmutación además cierra la escritura en el CPD, escala los gateways y el integrador del sitio de respaldo y avisa a la mesa de soporte y al SIEM (ver [Arquitectura](../arquitectura.md#continuidad-entre-sitios)).

### Severidades y soporte

La severidad sale de preguntas cerradas, en orden (función `classifySeverity` de `@nexo/shared`, la misma regla que usa el asistente de la mesa de soporte):

1. ¿Consulta o solicitud de cambio, sin falla? → **S4**.
2. ¿Servicio productivo caído **sin** alternativa operativa? → **S1**.
3. ¿Caído **con** alternativa operativa? → **S2**.
4. ¿Degradación medible en producción o riesgo de seguridad activo? → **S2**.
5. En otro caso → **S3**.

| Severidad | Acuse | Diagnóstico | Solución o solución temporal |
| --- | --- | --- | --- |
| S1 | 1 h | 2 h | 4 h corridas |
| S2 | 4 h | 8 h | 24 h corridas |
| S3 | 8 h hábiles | 3 días hábiles | 10 días hábiles |
| S4 | 1 día hábil | — | Según lo acordado |

El reloj solo se pausa por causas tipificadas y con justificación visible para la institución. Después de un S1 o un S2, Yago entrega un análisis de causa raíz. Detalle en [Ciclo de vida y soporte](../ciclo-de-vida-y-soporte.md#niveles-de-servicio).

**Mesa de soporte** (<EstadoCapacidad id="mesa-soporte" />). Es un servicio en línea de Yago, con ingreso con MFA obligatorio; no forma parte del laboratorio. En la sesión, el instructor muestra el registro de un ticket con el asistente de severidad, los relojes de acuse, diagnóstico y solución, una pausa tipificada, el escalamiento y la aprobación de un acceso remoto. Los participantes practican la regla de severidad en el [ejercicio 6.4](#ejercicio-6-4).

### Manejo de un incidente

1. **Detectar**: una alerta (Prometheus → Alertmanager → Consola) o un reporte.
2. **Clasificar** la severidad con las preguntas cerradas y **registrar** el ticket (recepción 24x7).
3. **Mitigar** con lo que la plataforma ya ofrece: detener o revertir un despliegue, liberar o aprobar un bloqueo, reprocesar mensajes, conmutar de sitio.
4. **Corregir** con un parche que trae su plan de reversa.
5. **Aprender**: análisis de causa raíz en S1 y S2.

Una vulnerabilidad se reporta a <Contacto tipo="seguridad" /> (ver [Seguridad](../seguridad.md#reporte-de-vulnerabilidades)).

## Ejercicios de laboratorio

Cargue las ayudas en cada terminal: `source tools/lab-bootstrap/ayudas-curso.sh`.

### Ejercicio 6.1 · Métricas, tableros, logs y trazas {#ejercicio-6-1}

**Objetivo.** Ver la misma actividad desde cada señal.

**Pasos.**

1. **Terminal 2**: genere tráfico durante 3 minutos:

   ```bash
   pnpm --filter @nexo/lab-bootstrap carga -- --rps 10 --segundos 180
   ```

2. En Grafana (`http://localhost:3000`), tablero «Nexo · Plataforma»: solicitudes por segundo, tasa de error, latencia p95 por API, consumo por aplicación y mensajes en colas.
3. En Prometheus (`http://localhost:9090`), consulte:

   ```text
   sum by (apiName) (rate(nexo_gateway_counter_solicitudes_total[1m]))
   histogram_quantile(0.95, sum by (le, apiName) (rate(nexo_gateway_histogram_latencia_ms_bucket[5m])))
   up == 0
   ```

4. En OpenSearch, cuente los eventos de analítica y vea el último:

   ```bash
   curl -s 'http://localhost:9200/nexo-apim-metrics-*/_count' | jq .count
   curl -s 'http://localhost:9200/nexo-apim-metrics-*/_search?size=1&sort=@timestamp:desc' | jq '.hits.hits[0]._source | {apiName, applicationName, proxyResponseCode, responseLatency}'
   ```

5. En Jaeger (`http://localhost:16686`), elija un servicio y abra una traza reciente.

**Resultado esperado.** El tablero y Prometheus muestran unas 10 solicitudes por segundo para Concesiones (con un retraso del orden del intervalo de recolección, 15 s), sin errores 5xx, y la latencia p95 de la API. `up == 0` no devuelve resultados si todo está arriba. El conteo de analítica crece y el último evento es de la API Concesiones y la aplicación OperadorDemo con código 200. Jaeger muestra trazas del gateway y del integrador.

**Autoevaluación.**

- Si OpenSearch cae unos minutos, ¿se pierde la analítica de ese intervalo?

<details>
<summary>Respuesta</summary>

No: las entradas de Fluent Bit usan buffer en disco y reintentan sin límite; los eventos esperan y se envían cuando OpenSearch vuelve.

</details>

### Ejercicio 6.2 · Una alerta de punta a punta {#ejercicio-6-2}

**Objetivo.** Provocar una alerta y verla llegar a la Consola.

**Pasos.**

1. Detenga un backend que no atiende consumidores (la versión 1.1.0 de Concesiones, que solo usan los despliegues progresivos):

   ```bash
   (cd deploy/compose && docker compose --env-file .env stop concesiones-v2)
   ```

2. Siga la alerta durante unos 2 minutos: Prometheus (`http://localhost:9090/alerts`), Alertmanager (`http://localhost:9093`) y la Consola:

   ```bash
   consola carla.operacion GET /overview | jq .alertas
   ```

3. Vuelva a iniciar el backend y observe cómo se resuelve:

   ```bash
   (cd deploy/compose && docker compose --env-file .env start concesiones-v2)
   ```

**Resultado esperado.** En Prometheus, `ComponenteCaido` pasa de pendiente a activa para el trabajo `backends` e instancia `concesiones-v2:7001` después de 1 minuto; Alertmanager la agrupa y la envía al webhook; el resumen de la Consola muestra `abiertas` mayor o igual a 1. Al iniciar el backend, la alerta se resuelve en Prometheus y Alertmanager.

**Autoevaluación.**

- ¿Qué severidad trae `ComponenteCaido` y por qué no es S1?

<details>
<summary>Respuesta</summary>

S2: avisa que un componente no responde, lo que no significa por sí solo que el servicio productivo esté caído para todos sin alternativa. La severidad del incidente se decide con las preguntas cerradas.

</details>

### Ejercicio 6.3 · Continuidad entre sitios {#ejercicio-6-3}

**Objetivo.** Ver el quórum, ejecutar un simulacro y observar una conmutación automática con su RTO y el retorno guiado.

**Pasos.**

1. Levante el laboratorio de continuidad y vea el estado:

   ```bash
   make -C deploy/compose continuidad
   sleep 20
   consola luis.aprobador GET /continuity | jq '{activeSite, quorum, votosPrimarioCaido, sitios: [.sites[] | {id, role, vote, active}]}'
   docker exec nexo-lab-cont-etcd-1 etcdctl get /skydns/lab/nexo/activo
   ```

   Si todavía no aparecen los tres sitios, espere unos segundos y repita la consulta: los agentes votan cada 3 segundos.

2. Como operador, inicie un simulacro y vea su resultado:

   ```bash
   consola carla.operacion POST /continuity/drill | jq '{id, kind, status}'
   sleep 10
   consola luis.aprobador GET /continuity/events | jq '.[0] | {kind, trigger, status, rpoSecondsEstimated, steps}'
   ```

3. Ejecute la verificación de continuidad, que detiene el primario y dos agentes, comprueba que sin quórum no se conmuta, conmuta con quórum y aprueba el retorno:

   ```bash
   pnpm --filter @nexo/lab-bootstrap check:d05
   consola luis.aprobador GET /continuity/events | jq -c '.[0:3][] | {kind, trigger, from, to, status, rtoSeconds}'
   ```

**Resultado esperado.** Tres sitios (`cpd` primario, `gcp` respaldo y `testigo`) con voto `primario_sano`, sitio activo `cpd`, quórum «2 de 3» y el registro DNS con `"host":"10.80.0.1"`. El simulacro queda `completado` con el paso «verificar réplica al día» y los bytes de WAL sin aplicar. `check:d05` muestra que con un solo agente activo el sitio sigue siendo `cpd` y la réplica no se promueve; con quórum, el activo pasa a `gcp`, la réplica se promueve, el DNS cambia a 10.80.0.2 y un dato confirmado antes de la caída sigue presente; el evento de conmutación es `automatico`, `completado` y con RTO mayor que 0; el retorno aprobado vuelve a `cpd`. La línea final dice «verificado: quórum, conmutación automática con RTO/RPO medidos y retorno guiado».

**Autoevaluación.**

- ¿Por qué no basta con que el agente de Google Cloud vea caído el CPD para conmutar?
- ¿Por qué el retorno al CPD no es automático?

<details>
<summary>Respuestas</summary>

Porque podría ser un corte de red entre ese agente y el CPD, con el CPD sirviendo: conmutar dejaría dos sitios activos. El quórum de 2 de 3 lo evita. El retorno es guiado y con aprobación para no rebotar entre sitios y para que una persona confirme que el CPD está listo y la réplica sincronizada.

</details>

### Ejercicio 6.4 · Auditoría en el SIEM y severidades {#ejercicio-6-4}

**Objetivo.** Comprobar la entrega de la auditoría al SIEM y clasificar incidentes con la regla de Nexo.

**Pasos.**

1. Compare la cadena de la Consola con lo que tiene el SIEM del laboratorio:

   ```bash
   consola pedro.auditoria GET /audit-events/verify | jq '{ok, count, lastSeq}'
   curl -s 'http://localhost:9200/nexo-siem-*/_count' | jq .count
   curl -s 'http://localhost:9200/nexo-siem-*/_search?size=1&sort=seq:desc' | jq '.hits.hits[0]._source | {seq, action, actor, prevHash, hash}'
   ```

2. Ejecute la verificación del SIEM (detiene y vuelve a iniciar Fluent Bit):

   ```bash
   pnpm --filter @nexo/lab-bootstrap check:siem
   ```

3. Clasifique estos casos con la regla de la plataforma. Complete las respuestas de cada caso antes de ejecutar:

   ```bash
   node --input-type=module -e '
   import { classifySeverity } from "./packages/shared/dist/index.js";
   const no = { esConsultaOCambio: false, servicioProductivoCaido: false, existeAlternativa: false, degradacionOSeguridad: false, soloNoProductivoOMenor: false };
   const casos = {
     "Ningún gateway de producción responde": { ...no, servicioProductivoCaido: true },
     "Un nodo de gateway cayó y el otro sostiene el servicio": { ...no /* complete */ },
     "Falla el pipeline de promoción en QA": { ...no /* complete */ },
     "Se pide una nueva política de cuota": { ...no /* complete */ },
   };
   for (const [caso, r] of Object.entries(casos)) console.log(caso, "→", classifySeverity(r));'
   ```

**Resultado esperado.** La verificación de la cadena responde `"ok": true` y el SIEM tiene la misma cantidad de eventos (o se pone al día en segundos), con el último evento encadenado al anterior. `check:siem` muestra tres filas que cumplen: toda la cadena llegó y se verifica desde el SIEM; con el SIEM caído los eventos esperan en la base; al volver llegan todos en orden y un reenvío no duplica. La clasificación correcta es S1, S2, S3 y S4, en ese orden.

**Autoevaluación.**

- En el caso del nodo caído, ¿qué respuesta cambia la severidad de S2 a S1?

<details>
<summary>Respuesta</summary>

Que no exista alternativa operativa: si el otro nodo tampoco sostiene el servicio, es servicio productivo caído sin alternativa, S1.

</details>
