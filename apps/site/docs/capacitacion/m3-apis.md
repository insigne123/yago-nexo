---
title: "M3 · Diseño, publicación y ciclo de vida de APIs"
sidebar_label: "M3 · Ciclo de vida de APIs"
description: Módulo M3 de la capacitación de Yago Nexo (5 horas). Contratos y guía de estilo, promoción y reversa, catálogo e impacto, APIs GraphQL y de eventos, SDK y despliegues progresivos con reversa automática.
---

import EstadoCapacidad from '@site/src/components/EstadoCapacidad';

# M3 · Diseño, publicación y ciclo de vida de APIs

**Duración:** 5 horas · **Sesión:** 4 · **Rutas:** Desarrollo/APIs, Integración y Certificación

## Objetivos de aprendizaje

Al terminar el módulo, el participante:

1. Valida un contrato OpenAPI contra la guía de estilo institucional y corrige sus errores.
2. Promueve una API entre etapas y la revierte a la revisión anterior, sin editar a mano.
3. Exporta las APIs con un manifiesto de hashes y comprueba su integridad.
4. Usa el catálogo de la Consola: ficha de gobierno, dependencias y simulación de impacto.
5. Consume APIs GraphQL y de eventos y genera SDK desde el Dev Portal.
6. Ejecuta un despliegue progresivo (canary) y explica cómo se revierte solo una versión defectuosa.

## Agenda

| Bloque | Tiempo | Contenido |
| --- | --- | --- |
| 1 | 0:00 – 0:30 | Contrato primero: proyecto de API, guía de estilo y gobierno en WSO2. |
| 2 | 0:30 – 1:15 | [Ejercicio 3.1](#ejercicio-3-1): validar y corregir un contrato. |
| 3 | 1:15 – 2:00 | [Ejercicio 3.2](#ejercicio-3-2): promoción, reversa y exportación. |
| — | 2:00 – 2:15 | Pausa. |
| 4 | 2:15 – 3:15 | Catálogo, impacto, GraphQL, eventos y SDK. [Ejercicio 3.3](#ejercicio-3-3). |
| — | 3:15 – 3:30 | Pausa. |
| 5 | 3:30 – 4:45 | Despliegues progresivos. [Ejercicio 3.4](#ejercicio-3-4). |
| 6 | 4:45 – 5:00 | Cierre y autoevaluación. |

## Conceptos

### Proyecto de API

Cada API vive en Git como un proyecto (`wso2/apim/apis/<nombre>/`):

- `api.yaml`: nombre, versión, contexto, tipo (HTTP, GRAPHQL, WS…), dueños de negocio y técnico, metadatos (propósito, audiencia, clasificación), seguridad, planes, endpoints por etapa, resiliencia (tiempo de espera, reintentos y suspensión), gateways por etapa y, si corresponde, `division` para despliegues progresivos.
- El contrato: OpenAPI, esquema GraphQL o AsyncAPI.

### Guía de estilo y gobierno

`wso2/apim/governance/guia-estilo-institucional.yaml` define reglas con severidad. Las de severidad **error** bloquean; las **advertencias** se informan:

| Regla | Severidad |
| --- | --- |
| `info.contact` con nombre y correo; `info.description` de al menos 30 caracteres; versión `MAYOR.MENOR.PARCHE` | error |
| Rutas en minúsculas con guiones, sin barra final | error |
| Cada operación con `summary` y `responses` | error |
| Servidores con HTTPS o rutas relativas; sin autenticación HTTP basic | error |
| Operaciones con `tags` y `operationId` en camelCase; propiedades en camelCase | advertencia |

La guía se aplica en dos lugares: en el pipeline (`nexo-ctl api lint` y `api deploy`, que se detiene si hay errores) y en WSO2, donde la política «Nexo · Contratos institucionales» bloquea el despliegue y la publicación de contratos con errores (<EstadoCapacidad id="gobierno-contratos" />). La revisión OWASP API Security Top 10 solo avisa.

### Promoción, reversa y exportación

- `nexo-ctl api deploy <proyecto> -s <etapa>`: valida, crea o actualiza la API, crea una **revisión** y la despliega en los gateways de la etapa.
- `nexo-ctl api rollback <nombre> <versión> -s <etapa>`: vuelve a desplegar la revisión anterior donde está desplegada la actual.
- `nexo-ctl api export -s <etapa> -o <carpeta>`: un zip por API (formato de proyecto de WSO2) y `manifiesto.json` con la suma SHA-256 de cada archivo.

### Catálogo e impacto

La Consola sincroniza su catálogo con WSO2 (`POST /catalog/sync`) y arma una ficha por API con ocho campos de gobierno (propósito, dueño, contrato, versión, autenticación, consumidores, dependencias y estado) y su completitud. El grafo de dependencias une APIs, flujos de integración, sistemas y consumidores; `POST /impact/simulate` muestra qué se ve afectado por un cambio (<EstadoCapacidad id="catalogo-impacto" />).

### GraphQL, eventos y SDK

- **ConcesionesGraphQL**: API GraphQL en `https://apim:8243/graphql/concesiones/1.0.0`.
- **EventosRed**: API de WebSocket descrita con AsyncAPI en `wss://apim:8099/eventos/red/1.0.0`.
- El Dev Portal genera SDK en Java, JavaScript, Python, C# y Android desde el contrato publicado (<EstadoCapacidad id="sdk" />).

### Despliegues progresivos

En producción, Concesiones pasa por `nexo-division` (Envoy). El motor de despliegues cambia los pesos entre la versión estable y la candidata **sin redesplegar la API** (<EstadoCapacidad id="motor-despliegues" />):

- **Canary** por pasos (por omisión 5, 25, 50 y 100 %), con un **tráfico sombra** opcional: la candidata recibe una copia de las lecturas y sus respuestas no llegan a los consumidores.
- **Blue-green**: cambia todo el tráfico de una vez.
- Cada paso compara la candidata con umbrales (por omisión: errores hasta 2 %, p99 hasta 800 ms y al menos 20 solicitudes). Si falla, **revierte solo**.
- Lo crea un desarrollador y lo aprueba un aprobador distinto (cuatro ojos); un operador lo puede detener.

## Ejercicios de laboratorio

Cargue las ayudas en cada terminal: `source tools/lab-bootstrap/ayudas-curso.sh`.

### Ejercicio 3.1 · Validar y corregir un contrato {#ejercicio-3-1}

**Objetivo.** Usar la guía de estilo como lo hace el pipeline y dejar un contrato sin errores ni advertencias.

**Pasos.**

1. Valide un contrato que cumple y uno de ejemplo que no cumple:

   ```bash
   nexo-ctl api lint wso2/apim/apis/concesiones/openapi.yaml; echo "código de salida: $?"
   nexo-ctl api lint wso2/apim/apis/_ejemplos/contrato-incumple.yaml; echo "código de salida: $?"
   ```

2. Copie el contrato que no cumple y corríjalo hasta que la validación no informe nada:

   ```bash
   mkdir -p out/curso && cp wso2/apim/apis/_ejemplos/contrato-incumple.yaml out/curso/reportes-internos.yaml
   # edite out/curso/reportes-internos.yaml y vuelva a validar
   nexo-ctl api lint out/curso/reportes-internos.yaml
   ```

**Resultado esperado.** El contrato de Concesiones da «0 errores, 0 advertencias» y código 0. El de ejemplo da 8 errores y 2 advertencias y código 2: falta `info.contact` y una descripción, la versión no es `1.2.3`, el servidor no usa HTTPS, las rutas no están en kebab-case, falta un `summary` y usa HTTP basic. El contrato corregido da «Resultado: 0 errores, 0 advertencias, 0 info.».

<details>
<summary>Una corrección posible</summary>

```yaml
openapi: 3.0.3
info:
  title: Reportes Internos
  version: 1.0.0
  description: Reportes internos de gestión para las áreas de la institución (datos sintéticos).
  contact:
    name: Equipo de Reportes (sintético)
    email: reportes@ejemplo.invalid
servers:
  - url: https://apim:8243/reportes/1.0.0
paths:
  /reportes:
    get:
      tags: [reportes]
      operationId: listarReportes
      summary: Lista los reportes disponibles
      responses:
        "200": { description: ok }
  /reportes/{id}:
    get:
      tags: [reportes]
      operationId: obtenerReporte
      summary: Obtiene el detalle de un reporte
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200": { description: ok }
components:
  securitySchemes:
    oauth2:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: http://keycloak:8080/realms/nexo/protocol/openid-connect/token
          scopes: {}
security:
  - oauth2: []
```

</details>

**Autoevaluación.**

- La validación da 0 errores y 3 advertencias. ¿Se puede promover la API?
- ¿Qué pasaría si alguien intenta desplegar en WSO2, sin pasar por `nexo-ctl`, una API cuyo contrato tiene errores?

<details>
<summary>Respuestas</summary>

Sí: solo los errores bloquean; las advertencias se informan para corregirlas. WSO2 bloquea el despliegue y la publicación, porque la política de gobierno «Nexo · Contratos institucionales» usa la misma guía.

</details>

### Ejercicio 3.2 · Promoción, reversa y exportación {#ejercicio-3-2}

**Objetivo.** Cambiar una API desde su proyecto, promoverla, revertirla y exportar con integridad comprobable.

**Pasos.**

1. Despliegue Concesiones en desarrollo y luego en QA:

   ```bash
   nexo-ctl api deploy wso2/apim/apis/concesiones -s dev -m "curso: despliegue en desarrollo"
   nexo-ctl api deploy wso2/apim/apis/concesiones -s qa  -m "curso: promoción a QA"
   ```

2. En el Publisher, abra Concesiones → **Deployments** y vea qué revisión quedó en cada gateway.
3. Despliegue de nuevo en desarrollo y revierta esa etapa:

   ```bash
   nexo-ctl api deploy wso2/apim/apis/concesiones -s dev -m "curso: cambio a revertir"
   nexo-ctl api rollback Concesiones 1.0.0 -s dev
   ```

4. Exporte las APIs de producción y compruebe una suma contra el manifiesto:

   ```bash
   nexo-ctl api export -s prod -o out/curso/export
   sha256sum out/curso/export/Concesiones-1.0.0.zip
   jq -r '.items[] | select(.archivo == "Concesiones-1.0.0.zip") | .sha256' out/curso/export/manifiesto.json
   ```

**Resultado esperado.** Cada despliegue informa «Revisión … desplegada en: Desarrollo (dev.nexo.lab)» o «QA (qa.nexo.lab)». La reversa informa «Reversa: Concesiones 1.0.0 vuelve de la revisión … a … en Desarrollo». La exportación lista cada API exportada y el manifiesto; las dos sumas SHA-256 son iguales.

:::caution Reversa en el laboratorio

Las tres etapas comparten un API Manager y las revisiones son de la API: la reversa actúa sobre la revisión desplegada **más reciente**, cualquiera sea su etapa. Por eso el paso 3 despliega en desarrollo justo antes de revertir. Si revierte sin ese despliegue previo, puede devolver los gateways de producción a una revisión anterior. En producción, cada etapa tiene su propia instalación y su propio historial.

:::

**Autoevaluación.**

- ¿Por qué el pipeline crea una revisión nueva en cada despliegue en vez de modificar la desplegada?

<details>
<summary>Respuesta</summary>

Porque una revisión es una foto inmutable de la API: permite saber exactamente qué hay en cada gateway y volver a la anterior sin editar a mano.

</details>

### Ejercicio 3.3 · Catálogo, impacto, GraphQL, eventos y SDK {#ejercicio-3-3}

**Objetivo.** Usar el catálogo de la Consola y consumir los otros tipos de API.

**Pasos.**

1. Sincronice el catálogo y revise las fichas:

   ```bash
   consola ana.desarrollo POST /catalog/sync | jq
   consola consumidor.demo GET /apis | jq -r '.[] | "\(.name) \(.version)  audiencia=\(.audience)  completitud=\(.completeness)%"'
   ```

2. Vea las dependencias que la Consola deriva del integrador y simule un cambio en el registro SOAP:

   ```bash
   consola ana.desarrollo GET /graph | jq '[.edges[] | select(.source == "analizador_mi")] | length'
   consola ana.desarrollo POST /impact/simulate '{"nodeId":"sistema:registro-soap:7001","change":{"kind":"campo","detail":"Se elimina el campo estado"}}' | jq '.affected'
   ```

3. Consuma la API GraphQL con el token de OperadorDemo (la verificación `check:d06` la suscribe si falta):

   ```bash
   pnpm --filter @nexo/lab-bootstrap check:d06
   APP=$(app_tok OperadorDemo)
   curl -sk -X POST https://apim:8243/graphql/concesiones/1.0.0 -H "Authorization: Bearer $APP" \
     -H 'content-type: application/json' -d '{"query":"{ totalPorEstado { estado total } }"}' | jq
   ```

4. Genere SDK desde el contrato publicado:

   ```bash
   pnpm --filter @nexo/lab-bootstrap check:d07
   ls -l out/sdk
   ```

   También puede descargarlos en el Dev Portal: Concesiones → **SDKs**.

**Resultado esperado.** El catálogo muestra las cinco APIs con su audiencia y 100 % de completitud. El grafo tiene dependencias derivadas del integrador y la simulación afecta al menos un flujo y una API; los consumidores afectados aparecen cuando alguna aplicación está suscrita a esas APIs (OperadorDemo queda suscrita a SolicitudesConcesion con `check:integracion`, en M4). `check:d06` informa GraphQL correcto y al menos dos eventos recibidos por WebSocket; la consulta GraphQL devuelve el total por estado. `check:d07` informa los lenguajes disponibles y deja en `out/sdk` los zip generados (al menos tres de Java, JavaScript, Python y C#).

**Autoevaluación.**

- ¿Quién debe ser avisado si se elimina el campo `estado` del registro SOAP?

<details>
<summary>Respuesta</summary>

Los dueños de los flujos y APIs afectados y sus consumidores: la simulación de impacto los lista (el flujo de solicitudes del integrador, la API SolicitudesConcesion y las aplicaciones suscritas a ella).

</details>

### Ejercicio 3.4 · Despliegue progresivo con reversa automática {#ejercicio-3-4}

**Objetivo.** Llevar la versión 1.1.0 de Concesiones a producción por pasos, sin errores para los consumidores, y ver cómo una versión defectuosa se revierte sola.

**Requisitos.** `make deploy-apis` (la ruta de Concesiones en `nexo-division`) y dos terminales con las ayudas cargadas.

**Pasos.**

1. Ubique la ruta y compruebe que no hay un despliegue en curso:

   ```bash
   consola ana.desarrollo POST /catalog/sync > /dev/null
   consola luis.aprobador GET /traffic-routes | jq '.[] | {apiId, apiName, stableUrl, weight, rolloutId}'
   API_ID=$(consola luis.aprobador GET /traffic-routes | jq -r '.[] | select(.apiName | startswith("Concesiones ")) | .apiId')
   ```

2. **Terminal 2**: deje corriendo carga de fondo a través del gateway (20 llamadas por segundo, 3 minutos):

   ```bash
   pnpm --filter @nexo/lab-bootstrap carga -- --rps 20 --segundos 180
   ```

3. **Terminal 1**: cree el despliegue como desarrollador, apruébelo como aprobador y sígalo:

   ```bash
   RID=$(consola ana.desarrollo POST /rollouts "{\"apiId\":\"$API_ID\",\"strategy\":\"canary\",\"candidateEndpoint\":\"http://concesiones-v2:7001\",\"shadowSeconds\":15,\"steps\":[5,25,50,100],\"stepDurationSec\":15,\"thresholds\":{\"maxErrorRate\":0.02,\"maxP99Ms\":800,\"minRequests\":10}}" | jq -r .id)
   consola luis.aprobador POST "/rollouts/$RID/approve" | jq .status
   while sleep 3; do consola luis.aprobador GET "/rollouts/$RID" | jq -c '{status, currentWeight, pasos: [.stepsDone[] | {kind, weight, decision}]}'; done
   ```

   Detenga el seguimiento con Ctrl+C cuando el estado deje de ser `en_curso`.

4. Cuando termine, vuelva a la versión 1.0.0 de una vez (blue-green). Antes, relance la carga en la terminal 2 (mismo comando del paso 2):

   ```bash
   RID=$(consola ana.desarrollo POST /rollouts "{\"apiId\":\"$API_ID\",\"strategy\":\"blue_green\",\"candidateEndpoint\":\"http://concesiones-v1:7001\",\"stepDurationSec\":15,\"thresholds\":{\"maxErrorRate\":0.02,\"maxP99Ms\":800,\"minRequests\":10}}" | jq -r .id)
   consola luis.aprobador POST "/rollouts/$RID/approve" | jq .status
   ```

5. Ahora una versión defectuosa. Con la carga corriendo de nuevo en la terminal 2, haga fallar la versión 1.1.0, repita el canary con sombra y restablezca:

   ```bash
   caos 1 7011
   RID=$(consola ana.desarrollo POST /rollouts "{\"apiId\":\"$API_ID\",\"strategy\":\"canary\",\"candidateEndpoint\":\"http://concesiones-v2:7001\",\"shadowSeconds\":30,\"steps\":[5,25,50,100],\"stepDurationSec\":15,\"thresholds\":{\"maxErrorRate\":0.02,\"maxP99Ms\":800,\"minRequests\":10}}" | jq -r .id)
   consola luis.aprobador POST "/rollouts/$RID/approve" | jq .status
   sleep 45; consola luis.aprobador GET "/rollouts/$RID" | jq '{status, rollbackReason, ultimo: .stepsDone[-1].kind}'
   caos 0 7011
   ```

**Resultado esperado.** En el paso 3, el despliegue pasa por sombra y por 5, 25, 50 y 100 %, y termina `completado`; en la terminal 2, cada segundo muestra respuestas de `v1.0.0` y de `v1.1.0` en proporción creciente, y el resumen final no tiene errores. El blue-green termina `completado` y la carga vuelve a mostrar solo `v1.0.0`. La versión defectuosa termina `revertido` en la etapa de sombra, con el motivo en `rollbackReason`, y los consumidores no reciben errores. La verificación `check:d04` automatiza estos tres escenarios.

**Autoevaluación.**

- ¿Por qué la versión defectuosa no causó errores a los consumidores?
- ¿Qué pasa si nadie aprueba el despliegue creado por el desarrollador?

<details>
<summary>Respuestas</summary>

Porque falló en la etapa de sombra: la candidata recibía copias de las lecturas y sus respuestas no se entregaban; al superar el umbral de errores, el motor revirtió antes de darle tráfico real. Si nadie lo aprueba, queda pendiente de aprobación y no se aplica ningún cambio de pesos.

</details>
