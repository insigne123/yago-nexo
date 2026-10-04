---
title: "M0 · Inducción, arquitectura y laboratorio"
sidebar_label: "M0 · Inducción y laboratorio"
description: Módulo M0 de la capacitación de Yago Nexo (4 horas). Qué es Nexo, sus capas y estados, la arquitectura objetivo y el laboratorio propio de cada participante.
---

import EstadoCapacidad from '@site/src/components/EstadoCapacidad';

# M0 · Inducción, arquitectura y laboratorio

**Duración:** 4 horas · **Sesión:** 1 · **Rutas:** todas

## Objetivos de aprendizaje

Al terminar el módulo, el participante:

1. Explica qué es Yago Nexo: una distribución que combina WSO2 API Manager 4.7.0 y Micro Integrator 4.6.0 con la capa propia de Yago.
2. Reconoce cada componente del laboratorio, su función y su puerto.
3. Lee el estado de una capacidad (*Disponible*, *En desarrollo* o *Planificado*) y sabe dónde está su evidencia.
4. Tiene su laboratorio arriba, comprobado de punta a punta.
5. Llama a una API protegida con un token de Keycloak y explica por qué sin token recibe 401.

## Agenda

| Bloque | Tiempo | Contenido |
| --- | --- | --- |
| 1 | 0:00 – 0:30 | Presentación, rutas por rol, reglas del curso y del laboratorio. |
| 2 | 0:30 – 1:15 | Qué es Nexo: base abierta, capa Yago, estados de las capacidades. Arquitectura objetivo (diseño). |
| 3 | 1:15 – 2:15 | [Ejercicio 0.1](#ejercicio-0-1): levantar el laboratorio propio. Mientras construye, recorrido por `deploy/compose`. |
| — | 2:15 – 2:30 | Pausa. |
| 4 | 2:30 – 3:00 | [Ejercicio 0.2](#ejercicio-0-2): arranque y prueba de punta a punta. |
| 5 | 3:00 – 3:30 | [Ejercicio 0.3](#ejercicio-0-3): recorrido por las interfaces. |
| 6 | 3:30 – 4:00 | [Ejercicio 0.4](#ejercicio-0-4): llamada con token. Cierre y autoevaluación. |

## Conceptos

### Qué es Nexo

Nexo es una **distribución**: toma componentes de código abierto, los configura como un solo producto y agrega una capa propia. No reprograma lo que la base ya resuelve.

| Capa | Componentes | En el laboratorio |
| --- | --- | --- |
| Gestión de APIs | WSO2 API Manager 4.7.0: gateway, Publisher, Dev Portal, Admin y Key Manager | Servicio `apim` (todo en uno) y `gw-publico` (gateway de la audiencia pública) |
| Integración | WSO2 Micro Integrator 4.6.0 y RabbitMQ | Servicios `mi` y `rabbitmq` |
| Identidad | Keycloak (realm `nexo`) | Servicio `keycloak` |
| Datos | PostgreSQL 16 | Servicio `postgres` (bases de API Manager, Micro Integrator y Consola) |
| Capa Yago | Consola Nexo (API), motores de descubrimiento, anomalías, despliegues y reenvío al SIEM; agentes de continuidad | `console-api`, `motores`, `nexo-division` y, en el perfil `cont`, los agentes |
| Observabilidad | OpenTelemetry Collector, Jaeger, Prometheus, Alertmanager, Grafana, OpenSearch y Fluent Bit | Perfil `obs` |

### Perfiles del laboratorio

| Perfil | Qué agrega | Se usa en |
| --- | --- | --- |
| núcleo | WSO2, Keycloak, PostgreSQL, RabbitMQ, Consola, motores y backends de ejemplo | Todo el curso |
| `obs` | Observabilidad completa | Desde M0 |
| `legacy` | APISIX y un NGINX heredado con APIs no gobernadas | M5 (descubrimiento) |
| `cont` | Dos PostgreSQL con replicación (CPD y GCP), etcd, CoreDNS y tres agentes de continuidad | M6 |

### Estados de las capacidades

Cada capacidad del producto tiene un estado en un único archivo de datos del sitio. Una capacidad solo figura como *Disponible* si declara una ruta de evidencia que existe en el repositorio; si no, el sitio no se genera. En este curso, lo *Disponible* se practica en el laboratorio y lo *En desarrollo* se explica sin ejercicios. Todas las capacidades están en la [hoja de ruta](../hoja-de-ruta.md).

### Arquitectura objetivo (diseño)

El laboratorio reúne todo en un equipo; la arquitectura objetivo separa sitios y réplicas (ver [Arquitectura](../arquitectura.md)):

- **CPD** de la institución como sitio principal, **Google Cloud** como respaldo en espera tibia y un **testigo** de quórum en un tercer lugar.
- La conmutación exige **2 de 3 votos** (<EstadoCapacidad id="motor-continuidad" />). El laboratorio de continuidad (perfil `cont`) reproduce esa lógica en un equipo.
- Los instaladores para producción están en estado <EstadoCapacidad id="helm" />.

### Flujo de una llamada

La aplicación consumidora pide un token a Keycloak (`client_credentials`), llama al gateway con `Authorization: Bearer <token>`, el gateway valida el token y la suscripción, y reenvía al backend. Sin token, el gateway responde 401. Es lo que comprueba el arranque del laboratorio (ver [Flujo de una llamada](../arquitectura.md#flujo-de-una-llamada)).

## Ejercicios de laboratorio

### Ejercicio 0.1 · Levantar el laboratorio propio {#ejercicio-0-1}

**Objetivo.** Tener el laboratorio del participante construido y con sus servicios sanos.

**Pasos.**

1. Revise que el equipo cumple los [requisitos](./laboratorio-participante.md#requisitos):

   ```bash
   docker compose version && make --version | head -1 && node --version && pnpm --version && jq --version
   ```

2. Siga los pasos 1 a 3 de la [preparación](./laboratorio-participante.md#preparacion): dependencias, `.env`, `make hosts` y `make up`.
3. Mientras construye, abra `deploy/compose/docker-compose.yml` y ubique los servicios `apim`, `keycloak`, `mi`, `console-api` y `motores`, y qué perfil tiene cada servicio de observabilidad.
4. Repita hasta que API Manager y Keycloak estén sanos:

   ```bash
   make -C deploy/compose status
   ```

**Resultado esperado.** `make status` muestra todos los servicios `Up`, y `apim`, `keycloak`, `postgres`, `rabbitmq` y `opensearch` con `(healthy)`. Los servicios `apim-dbinit` y `opensearch-plantillas` corren una vez y terminan.

**Autoevaluación.**

- ¿Qué perfil aporta Jaeger y Grafana?
- ¿Qué servicio atiende la audiencia pública y en qué puerto del equipo?

<details>
<summary>Respuestas</summary>

El perfil `obs`. La audiencia pública la atiende `gw-publico`, un gateway separado, en el puerto 18243.

</details>

### Ejercicio 0.2 · Arranque y prueba de punta a punta {#ejercicio-0-2}

**Objetivo.** Configurar WSO2 y Keycloak con el arranque y comprobar que una llamada real atraviesa gateway, Keycloak y backend.

**Pasos.**

1. Ejecute el arranque:

   ```bash
   make -C deploy/compose bootstrap
   ```

2. Lea la salida e identifique cada etapa: scope en Keycloak, colas de RabbitMQ, tabla de idempotencia, Key Manager, API Concesiones, aplicación OperadorDemo, suscripción y prueba de punta a punta.
3. Ejecútelo de nuevo y compare la salida.

**Resultado esperado.** La primera ejecución crea los objetos y termina con `PRUEBA DE PUNTA A PUNTA OK` (status 200) y `Sin token el gateway rechaza la llamada` (status 401). La segunda informa «ya existe» para el Key Manager y la API, y vuelve a pasar la prueba: el arranque es idempotente.

**Autoevaluación.**

- ¿Por qué el arranque usa `https://apim:9443` y no `https://localhost:9443`?
- ¿Qué haría si termina con «API Manager no respondió en 300s»?

<details>
<summary>Respuestas</summary>

Porque registra esas mismas URL en WSO2, que las resuelve dentro de la red de Docker; el equipo las resuelve gracias a `make hosts`. Si API Manager no respondió, todavía está iniciando: revisar `make -C deploy/compose logs S=apim` y volver a ejecutar el arranque.

</details>

### Ejercicio 0.3 · Recorrido por las interfaces {#ejercicio-0-3}

**Objetivo.** Ubicar en cada interfaz lo que creó el arranque.

**Pasos.** Use la tabla de [accesos](./laboratorio-participante.md#accesos) y las credenciales de `deploy/compose/.env`.

1. **Publisher** (`https://apim:9443/publisher`): abra la API Concesiones 1.0.0, vea su estado de ciclo de vida, sus revisiones y en qué gateway está desplegada.
2. **Dev Portal** (`https://apim:9443/devportal`): abra la aplicación OperadorDemo y vea su suscripción y sus llaves de producción del Key Manager «Keycloak institucional».
3. **Admin Portal** (`https://apim:9443/admin`): vea el Key Manager registrado.
4. **Keycloak** (`http://keycloak:8080/admin/`): en el realm `nexo`, vea los usuarios de ejemplo y sus grupos.
5. **RabbitMQ** (`http://localhost:15672/`): vea las colas `solicitudes.nuevas`, `solicitudes.reintento.1` a `.3` y `solicitudes.dlq`.
6. **Grafana** (`http://localhost:3000/`): abra el tablero «Nexo · Plataforma».

**Resultado esperado.** Concesiones aparece publicada (*Published*) y desplegada en el gateway Default; OperadorDemo tiene llaves y una suscripción; el Key Manager «Keycloak institucional» está activo; hay un usuario por rol en Keycloak; las colas existen vacías; el tablero carga con datos de Prometheus.

**Autoevaluación.**

- ¿Qué componente emitió las llaves de OperadorDemo?
- ¿Qué cola recibe los mensajes que agotan sus reintentos?

<details>
<summary>Respuestas</summary>

Keycloak, registrado como Key Manager de API Manager. La cola `solicitudes.dlq`.

</details>

### Ejercicio 0.4 · Llamada con token {#ejercicio-0-4}

**Objetivo.** Repetir a mano la prueba de punta a punta y leer el token.

**Pasos.**

1. Cargue las ayudas y obtenga el token de OperadorDemo:

   ```bash
   source tools/lab-bootstrap/ayudas-curso.sh
   APP=$(app_tok OperadorDemo)
   ```

2. Lea el contenido del token (emisor, aplicación y vencimiento):

   ```bash
   node -e 'const p=JSON.parse(Buffer.from(process.argv[1].split(".")[1],"base64url"));console.log({iss:p.iss,azp:p.azp,exp:new Date(p.exp*1000)})' "$APP"
   ```

3. Llame a la API con y sin token:

   ```bash
   curl -sk -H "Authorization: Bearer $APP" "https://apim:8243/concesiones/1.0.0/concesiones?estado=vigente" | jq '{total, version}'
   curl -sk -o /dev/null -w '%{http_code}\n' "https://apim:8243/concesiones/1.0.0/concesiones?estado=vigente"
   ```

**Resultado esperado.** El token lo emite `http://keycloak:8080/realms/nexo`, `azp` es la consumer key de OperadorDemo y vence a los 15 minutos. Con token se obtiene el total de concesiones vigentes y la versión `1.0.0`; sin token, `401`.

**Autoevaluación.**

- ¿Quién valida el token: Keycloak o el gateway?
- Si espera 20 minutos y repite la llamada con el mismo token, ¿qué espera recibir?

<details>
<summary>Respuestas</summary>

El gateway lo valida (firma con las llaves públicas del realm, emisor y suscripción de la aplicación); Keycloak solo lo emite. Pasados 15 minutos el token venció y el gateway rechaza la llamada: hay que pedir uno nuevo.

</details>

## Antes de la próxima sesión {#antes-de-la-proxima-sesion}

- **Rutas con M1** (Administración y Certificación): el resto de la preparación se hace en M1.
- **Rutas sin M1** (Desarrollo/APIs, Integración y Seguridad): complete ahora los pasos 4 y 5 de la [preparación](./laboratorio-participante.md#preparacion) (`make platform`, `make deploy-apis`, las cuatro APIs restantes y `make legado`), con apoyo del instructor.
