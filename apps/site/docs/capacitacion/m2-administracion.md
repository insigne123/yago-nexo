---
title: "M2 · Administración de la plataforma"
sidebar_label: "M2 · Administración"
description: Módulo M2 de la capacitación de Yago Nexo (5 horas). Flujos de aprobación, planes de uso, ambientes de gateway, identidad con Keycloak, roles de la Consola y estado de los motores.
---

import EstadoCapacidad from '@site/src/components/EstadoCapacidad';
import { SiNoDisponible } from '@site/src/components/SegunEstado';

# M2 · Administración de la plataforma

**Duración:** 5 horas · **Sesión:** 3 · **Rutas:** Administración, Desarrollo/APIs, Seguridad y Certificación

## Objetivos de aprendizaje

Al terminar el módulo, el participante:

1. Aprueba solicitudes de autoservicio (aplicaciones, credenciales y suscripciones) en el Admin Portal y explica qué pasos requieren aprobación.
2. Relaciona los planes de uso con el comportamiento del gateway: límite por minuto y ráfaga por segundo.
3. Administra la identidad del laboratorio en Keycloak: usuarios, grupos y roles de la Consola.
4. Comprueba la matriz rol-permiso y la regla de cuatro ojos en la API de la Consola.
5. Revisa la salud de la plataforma y de los motores de Nexo.

## Agenda

| Bloque | Tiempo | Contenido |
| --- | --- | --- |
| 1 | 0:00 – 0:30 | Consolas de administración: Admin Portal, Keycloak, API de la Consola. Autoservicio con aprobación. |
| 2 | 0:30 – 1:30 | [Ejercicio 2.1](#ejercicio-2-1): aplicación propia, de la solicitud a la primera llamada. |
| — | 1:30 – 1:45 | Pausa. |
| 3 | 1:45 – 2:30 | Planes de uso y límites. [Ejercicio 2.2](#ejercicio-2-2). |
| 4 | 2:30 – 3:30 | Identidad, roles y cuatro ojos. [Ejercicio 2.3](#ejercicio-2-3). |
| — | 3:30 – 3:45 | Pausa. |
| 5 | 3:45 – 4:45 | Motores de Nexo y salud de la plataforma. [Ejercicio 2.4](#ejercicio-2-4). |
| 6 | 4:45 – 5:00 | Cierre y autoevaluación. |

## Conceptos

### Autoservicio con aprobación

Con la plataforma aplicada (`make platform`), los consumidores se atienden solos en el Dev Portal, pero cada paso sensible queda pendiente hasta que una persona lo aprueba en el Admin Portal (**Tasks**) o por la Admin REST API:

| Paso | ¿Requiere aprobación? |
| --- | --- |
| Autorregistro de un usuario en el Dev Portal | Sí |
| Creación de una aplicación | Sí |
| Credenciales de producción | Sí |
| Credenciales sandbox | No |
| Suscripción a una API (y cambio de plan) | Sí |
| Despliegue de revisiones | No en WSO2: lo controla el pipeline (`nexo-ctl`) |

La fuente es `wso2/apim/workflows/workflow-extensions.xml`.

### Planes de uso

Los planes de suscripción de `platform.yaml` limitan las llamadas por minuto y la **ráfaga** por segundo. No cobran: el consumo se atribuye a cada consumidor (<EstadoCapacidad id="consumo" />).

| Plan | Por minuto | Ráfaga por segundo | Para |
| --- | --: | --: | --- |
| Interno | 20.000 | 500 | Sistemas internos |
| OperadoresEstandar | 600 | 20 | Entidades externas, plan estándar |
| OperadoresAmpliado | 3.000 | 100 | Entidades externas con más volumen |
| Publico | 60 | 5 | Consumo público autorizado |

Además, la política de API `ApiProtegida` (30.000 por minuto) se aplica a Concesiones y SolicitudesConcesion, y la política de aplicación `AppEstandar` (1.200 por minuto) queda disponible para las aplicaciones. Al superar un límite, el gateway responde **429**.

### Ambientes de gateway

| Ambiente | Host virtual | Uso |
| --- | --- | --- |
| Default | `apim` | Producción, audiencia interna |
| Operadores | `operadores.nexo.lab` | Producción, entidades externas |
| Publico | `publico.nexo.lab` | Producción, público (gateway separado `gw-publico`, puerto 18243) |
| Desarrollo | `dev.nexo.lab` | Etapa de desarrollo |
| QA | `qa.nexo.lab` | Etapa de pruebas |

### Identidad y roles

- **Aplicaciones**: Keycloak es el Key Manager; cada aplicación tiene sus llaves y obtiene tokens `client_credentials`.
- **Personas**: el realm `nexo` trae un usuario por rol. El rol en la Consola sale del **grupo** de Keycloak (por ejemplo, `nexo-aprobadores`), que asigna un rol del cliente `nexo-console`; el rol viaja en el token (`resource_access.nexo-console.roles`).
- **Matriz rol-permiso**: seis roles y 27 permisos en `packages/shared/src/roles.ts`, la misma matriz con que la API autoriza cada acción (ver [Seguridad](../seguridad.md#minimo-privilegio)). Sin el permiso, la API responde **403** e indica el permiso que falta.
- **Cuatro ojos**: aprobar un despliegue a producción, un bloqueo, un reproceso o el retorno al sitio principal exige una persona distinta de quien inició.

<SiNoDisponible id="sso-keycloak">

:::note En desarrollo

El inicio de sesión único de las personas en Publisher, Dev Portal y Admin con el Keycloak de la institución está en estado <EstadoCapacidad id="sso-keycloak" />. En el laboratorio, los portales de WSO2 se usan con el usuario `admin` de API Manager; la Consola sí valida tokens del realm `nexo`.

:::

</SiNoDisponible>

### Motores de Nexo

El servicio `motores` ejecuta los motores de descubrimiento, guardián de anomalías, despliegues progresivos y reenvío al SIEM. Cada motor tiene **una réplica líder** (bloqueo de asesoría de PostgreSQL) y publica un latido. `GET /engines` de la Consola muestra, por motor, la réplica, si es líder, su último latido y su estado; pasados 60 segundos sin latido, el estado es `sin_latido`.

## Ejercicios de laboratorio

Cargue las ayudas en cada terminal: `source tools/lab-bootstrap/ayudas-curso.sh`.

### Ejercicio 2.1 · Una aplicación propia, de la solicitud a la primera llamada {#ejercicio-2-1}

**Objetivo.** Recorrer el autoservicio con aprobación: crear una aplicación, obtener credenciales, suscribirla y llamar a la API.

**Pasos.** Use un nombre propio para la aplicación, por ejemplo `App-<sus iniciales>`.

1. En el Dev Portal (`https://apim:9443/devportal`, usuario `admin`), cree la aplicación. Observe su estado.
2. En el Admin Portal (`https://apim:9443/admin`) → **Tasks** → **Application Creation**, apruébela.
3. En el Dev Portal, en **Production Keys**, genere las llaves con el Key Manager «Keycloak institucional» y el grant `client_credentials`. Observe el estado de las llaves.
4. En Admin Portal → **Tasks** → **Application Registration**, apruebe las credenciales.
5. En el Dev Portal, suscriba la aplicación a **Concesiones 1.0.0** con el plan **OperadoresEstandar**, y apruebe la suscripción en **Tasks** → **Subscription Creation**.
6. Obtenga el token y llame a la API:

   ```bash
   app_llaves App-XX            # reemplace App-XX por el nombre de su aplicación
   APP=$(app_tok App-XX)
   curl -sk -H "Authorization: Bearer $APP" "https://apim:8243/concesiones/1.0.0/concesiones?estado=vigente" | jq '{total, version}'
   ```

**Resultado esperado.** La aplicación, las credenciales de producción y la suscripción quedan pendientes hasta cada aprobación. Después de la tercera aprobación, `app_llaves` muestra la consumer key y el secret, y la llamada responde con el total de concesiones vigentes y la versión `1.0.0`.

:::caution No corra verificaciones a mitad del ejercicio

`check:audiencias`, `check:integracion` y `check:d06` aprueban solicitudes pendientes. Si corren durante el ejercicio, sus aprobaciones se adelantan a las suyas.

:::

**Autoevaluación.**

- ¿Qué paso del autoservicio no requiere aprobación en esta configuración?
- ¿Dónde se ven las solicitudes pendientes si no se usa el Admin Portal?

<details>
<summary>Respuestas</summary>

Generar credenciales sandbox (usa el ejecutor simple). Por la Admin REST API: `GET /api/am/admin/v4/workflows`, que es lo que usa el arranque del laboratorio para aprobar.

</details>

### Ejercicio 2.2 · Límites de uso {#ejercicio-2-2}

**Objetivo.** Ver cómo el gateway aplica la ráfaga del plan de suscripción.

**Pasos.**

1. Con la aplicación del ejercicio 2.1 (plan OperadoresEstandar, ráfaga de 20 por segundo), genere 40 llamadas por segundo durante 10 segundos:

   ```bash
   pnpm --filter @nexo/lab-bootstrap carga -- --app App-XX --rps 40 --segundos 10
   ```

2. Repita con 10 llamadas por segundo:

   ```bash
   pnpm --filter @nexo/lab-bootstrap carga -- --app App-XX --rps 10 --segundos 10
   ```

3. En el tablero «Nexo · Plataforma» de Grafana (`http://localhost:3000`), busque las respuestas por código.

**Resultado esperado.** Con 40 por segundo, la línea final `resumen` muestra en `porCodigo` respuestas `200` y `429`: lo que excede la ráfaga se rechaza. Con 10 por segundo, todas son `200`. En Grafana aparecen las respuestas 429 de la API Concesiones (el panel se actualiza con el intervalo de recolección de Prometheus, 15 s).

**Autoevaluación.**

- ¿Qué plan elegiría para una entidad externa que necesita 50 llamadas por segundo sostenidas?

<details>
<summary>Respuesta</summary>

OperadoresAmpliado (3.000 por minuto, ráfaga de 100 por segundo). OperadoresEstandar admite 600 por minuto, es decir, 10 por segundo en promedio.

</details>

### Ejercicio 2.3 · Identidad, roles y cuatro ojos {#ejercicio-2-3}

**Objetivo.** Comprobar de dónde sale el rol de una persona y cómo la API de la Consola aplica la matriz.

**Pasos.**

1. En Keycloak (`http://keycloak:8080/admin/`, realm `nexo`), abra `luis.aprobador`: vea su grupo y el rol de cliente `nexo-console` que le da ese grupo.
2. Pida a la Consola quién es cada persona y qué permisos tiene:

   ```bash
   for u in admin.nexo ana.desarrollo luis.aprobador carla.operacion pedro.auditoria consumidor.demo; do
     consola "$u" GET /me | jq -c '{usuario: .username, roles, permisos: (.permissions | length)}'
   done
   ```

3. Compare una misma ruta con distintos roles:

   ```bash
   consola_estado ana.desarrollo  GET /audit-events          # desarrollador
   consola        ana.desarrollo  GET /audit-events | jq     # cuerpo del rechazo
   consola_estado pedro.auditoria GET /audit-events          # auditor
   consola_estado admin.nexo      GET /audit-events/verify   # administrador
   consola_estado pedro.auditoria GET /audit-events/verify   # auditor
   consola pedro.auditoria GET /compliance/role-matrix | jq 'length'
   ```

4. Intente aprobar con un rol sin permiso. Primero sincronice el catálogo de la Consola con WSO2 y ubique la API Concesiones de producción en las rutas de `nexo-division`:

   ```bash
   consola ana.desarrollo POST /catalog/sync | jq
   API_ID=$(consola luis.aprobador GET /traffic-routes | jq -r '.[] | select(.apiName | startswith("Concesiones ")) | .apiId')
   RID=$(consola ana.desarrollo POST /rollouts "{\"apiId\":\"$API_ID\",\"strategy\":\"canary\",\"candidateEndpoint\":\"http://concesiones-v2:7001\",\"steps\":[10,50,100],\"stepDurationSec\":30}" | jq -r .id)
   consola_estado ana.desarrollo POST "/rollouts/$RID/approve"
   consola carla.operacion POST "/rollouts/$RID/abort" '{"reason":"Ejercicio 2.3: no se ejecuta"}' | jq .status
   ```

**Resultado esperado.** Cada persona tiene un solo rol, el de su grupo. El desarrollador recibe `403` en `/audit-events` y el cuerpo dice `"permission": "audit:read"`; el auditor recibe `200`. La verificación de la cadena da `403` al administrador y `200` al auditor. La matriz tiene 27 permisos. El desarrollador crea el despliegue, pero recibe `403` al aprobarlo; el operador lo detiene y queda `abortado`.

**Autoevaluación.**

- ¿Por qué el administrador no puede verificar la auditoría?
- Si una persona tuviera los roles desarrollador y aprobador, ¿podría aprobar el despliegue que ella creó?

<details>
<summary>Respuestas</summary>

Por segregación de funciones: `audit:verify` es solo del auditor, para que quien configura la plataforma no sea quien certifica su auditoría. No: aprobar un despliegue es una acción de cuatro ojos y la API rechaza con 403 a quien lo inició, aunque tenga el permiso.

</details>

### Ejercicio 2.4 · Motores y salud de la plataforma {#ejercicio-2-4}

**Objetivo.** Leer el estado de los motores y reconocer cuándo uno dejó de latir.

**Pasos.**

1. Revise la salud general y los motores:

   ```bash
   curl -s http://localhost:8090/api/v1/health | jq
   consola carla.operacion GET /overview | jq '{sitios: .sites, apis, alertas}'
   consola carla.operacion GET /engines | jq '.[] | {engine, instance, leader, status, lastSeen}'
   ```

2. Detenga el servicio de motores, espere poco más de un minuto y vuelva a consultar:

   ```bash
   (cd deploy/compose && docker compose --env-file .env stop motores)
   sleep 75
   consola carla.operacion GET /engines | jq '.[] | {engine, status, lastSeen}'
   ```

3. Vuelva a iniciarlo y compruebe que retoma el liderazgo:

   ```bash
   (cd deploy/compose && docker compose --env-file .env start motores)
   sleep 20
   consola carla.operacion GET /engines | jq '.[] | {engine, leader, status}'
   ```

4. En Prometheus (`http://localhost:9090/alerts`) busque la alerta que provocó la detención.

**Resultado esperado.** Con los motores arriba, aparecen `descubrimiento`, `guardian`, `despliegues` y `siem`, cada uno con una réplica líder y estado activo. Detenidos más de 60 segundos, su estado pasa a `sin_latido`. Al iniciarlos, vuelven a tener líder y estado activo. En Prometheus, la alerta `ComponenteCaido` del trabajo `nexo-motores` se activa al minuto sin respuesta y se resuelve al volver.

**Autoevaluación.**

- ¿Qué evita que dos réplicas del mismo motor trabajen a la vez?

<details>
<summary>Respuesta</summary>

Un bloqueo de asesoría de PostgreSQL por motor: solo la réplica que lo obtiene es líder. Si su conexión se corta, PostgreSQL libera el bloqueo y otra réplica toma el mando.

</details>
