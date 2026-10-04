---
title: "M1 · Instalación, despliegue y actualización"
sidebar_label: "M1 · Instalación y despliegue"
description: Módulo M1 de la capacitación de Yago Nexo (6 horas, 1 + 5). Configuración del laboratorio, plataforma como código, despliegue de APIs por etapas, verificación de una versión, actualización y restablecimiento.
---

import Comandos from '../_generated/comandos-laboratorio.md';
import EstadoCapacidad from '@site/src/components/EstadoCapacidad';
import { SiNoDisponible } from '@site/src/components/SegunEstado';

# M1 · Instalación, despliegue y actualización

**Duración:** 6 horas (1 hora en la sesión 1 y 5 horas en la sesión 2) · **Rutas:** Administración y Certificación

## Objetivos de aprendizaje

Al terminar el módulo, el participante:

1. Explica qué hace cada objetivo del `Makefile` del laboratorio y qué configura cada variable de `.env`.
2. Aplica la plataforma como código (`wso2/apim/platform.yaml`) y comprueba que la operación es idempotente.
3. Despliega APIs por etapas (desarrollo, QA y producción) con `nexo-ctl`, sin editar a mano.
4. Verifica la integridad y el inventario de componentes de una versión de Nexo.
5. Actualiza y restablece el laboratorio sin perder ni duplicar configuración.
6. Distingue lo que hoy se instala con el laboratorio de lo que entregarán los instaladores de producción (en desarrollo).

## Agenda

**Sesión 1 (1 hora, después de M0)**

| Bloque | Tiempo | Contenido |
| --- | --- | --- |
| 1 | 4:00 – 4:15 | Estructura del repositorio: `deploy/compose`, `wso2/apim`, `wso2/mi`, `tools/nexo-ctl`, `tools/lab-bootstrap`, `release/`. |
| 2 | 4:15 – 5:00 | [Ejercicio 1.1](#ejercicio-1-1): configuración del laboratorio. |

**Sesión 2 (5 horas)**

| Bloque | Tiempo | Contenido |
| --- | --- | --- |
| 1 | 0:00 – 0:30 | Plataforma como código: qué vive en `platform.yaml` y cómo lo aplica `nexo-ctl`. |
| 2 | 0:30 – 1:15 | [Ejercicio 1.2](#ejercicio-1-2): aplicar la plataforma y comprobarla en el Admin Portal. |
| 3 | 1:15 – 2:15 | Proyectos de API y etapas. [Ejercicio 1.3](#ejercicio-1-3): APIs del curso en las tres etapas. |
| — | 2:15 – 2:30 | Pausa. |
| 4 | 2:30 – 3:15 | Versiones, soporte y entregables (SBOM y sumas SHA-256). Primera parte del [ejercicio 1.4](#ejercicio-1-4). |
| 5 | 3:15 – 3:45 | Instalación en producción: diseño e instaladores (en desarrollo). |
| — | 3:45 – 4:00 | Pausa. |
| 6 | 4:00 – 4:45 | Segunda parte del ejercicio 1.4: actualizar y restablecer el laboratorio. |
| 7 | 4:45 – 5:00 | Cierre y autoevaluación. |

## Conceptos

### Qué se instala en el laboratorio

`make -C deploy/compose up` compila con pnpm los backends de ejemplo, los motores y la API de la Consola, construye las imágenes locales (API Manager y Micro Integrator con el controlador JDBC de PostgreSQL, el gateway público, la Consola y los motores) y levanta los servicios. Los comandos disponibles:

<Comandos />

### Variables del laboratorio

`deploy/compose/.env` (creado desde `.env.example`) tiene solo credenciales de laboratorio. Dos reglas importan:

- **Las bases de PostgreSQL y sus usuarios se crean una sola vez**, al inicializar el volumen. Cambiar una contraseña en `.env` después exige borrar los volúmenes (`make clean`).
- **`APIM_ENCRYPTION_KEY`** es la llave con que WSO2 cifra secretos (por ejemplo, el de un Key Manager o las llaves de las aplicaciones). Debe ser la misma en todos los nodos y no cambiar: si cambia, WSO2 no puede descifrar lo guardado.
- `make bootstrap` **no lee** `.env`; `make platform`, `make deploy-apis` y `make legado` sí. Si cambió credenciales, expórtelas antes del arranque.

### Plataforma como código

`wso2/apim/platform.yaml` es la fuente única de:

| Sección | Qué crea |
| --- | --- |
| `gatewayEnvironments` | Ambientes de gateway por etapa (Desarrollo, QA) y por audiencia (Operadores, Publico), cada uno con su host virtual. |
| `throttling` | Planes de suscripción Interno, OperadoresEstandar, OperadoresAmpliado y Publico (sin cobro), la política por aplicación AppEstandar y la política de API ApiProtegida. |
| `workflows` | Flujos de aprobación de `wso2/apim/workflows/workflow-extensions.xml` (autorregistro, aplicaciones, credenciales de producción y suscripciones). |
| `governance` | La guía de estilo como ruleset de WSO2 y las políticas que bloquean el despliegue o la publicación de contratos con errores. |

`make platform` la aplica con `nexo-ctl platform apply`. Es idempotente: lo que ya existe se informa y no se duplica.

### Proyectos de API y etapas

Cada API vive en `wso2/apim/apis/<nombre>/` como un proyecto: `api.yaml` (dueños, metadatos, planes, endpoints por etapa, gateways por etapa) y su contrato. `nexo-ctl api deploy <proyecto> -s <etapa>` valida el contrato, crea o actualiza la API, crea una revisión, la despliega en los gateways de esa etapa y la publica. En el laboratorio las tres etapas comparten un API Manager y se separan por gateway; en producción cada etapa es una instalación propia.

### Versiones y entregables

- Versionado semántico `MAYOR.MENOR.PARCHE`; cada versión menor recibe correcciones de seguridad durante 12 meses y cada parche trae su plan de reversa (ver [Ciclo de vida y soporte](../ciclo-de-vida-y-soporte.md)).
- Cada versión publica en `release/<versión>/` su SBOM CycloneDX, el inventario de licencias y `CHECKSUMS.txt` con las sumas SHA-256: <EstadoCapacidad id="sbom" />.

### Instalación en producción (diseño) {#produccion}

| Pieza | Qué hará | Estado |
| --- | --- | --- |
| Chart Helm `nexo-platform` | Instalación en Kubernetes con valores por ambiente, réplicas, autoescalamiento y sondas. | <EstadoCapacidad id="helm" /> |
| Instalador para CPD | RKE2 sobre máquinas virtuales VMware vSphere, con endurecimiento. | <EstadoCapacidad id="instalador-rke2" /> |
| Instalador para Google Cloud | GKE, red, DNS, almacenamiento y llaves con OpenTofu. | <EstadoCapacidad id="instalador-gke" /> |
| Despliegue declarativo | Argo CD sincroniza cada ambiente desde Git. | <EstadoCapacidad id="gitops" /> |
| Secretos | OpenBao, External Secrets Operator y WSO2 Secure Vault. | <EstadoCapacidad id="secretos" /> |
| Respaldo y restauración | Respaldo cifrado de PostgreSQL desde una instantánea consistente y prueba de restauración que compara tabla por tabla (ver [Respaldo y restauración](../operacion/respaldo-y-restauracion.md)). | <EstadoCapacidad id="respaldo" /> |

<SiNoDisponible id="helm">

:::note En desarrollo

Esta parte del módulo es conceptual: se revisa el diseño de la [arquitectura](../arquitectura.md) (componentes por ambiente, réplicas, continuidad) y cómo se traduce lo practicado en el laboratorio (plataforma como código, proyectos de API por etapa, llave de cifrado compartida). No tiene ejercicios hasta que los instaladores estén disponibles.

:::

</SiNoDisponible>

## Ejercicios de laboratorio

### Ejercicio 1.1 · Configuración del laboratorio {#ejercicio-1-1}

**Objetivo.** Saber qué levanta cada perfil y de dónde sale cada valor de configuración.

**Pasos.**

1. Liste los servicios de cada combinación de perfiles (no levanta nada):

   ```bash
   cd deploy/compose
   docker compose --env-file .env config --services | sort
   docker compose --env-file .env --profile obs --profile legacy config --services | sort
   docker compose --env-file .env --profile cont config --services | sort
   cd ../..
   ```

2. En `deploy/compose/Makefile`, ubique qué perfiles usa `make up` por omisión (variable `PROFILES`) y qué hace el objetivo `build`.
3. En `deploy/compose/.env`, identifique la llave de cifrado de WSO2 y las contraseñas de las bases.
4. En `deploy/compose/apim/config/repository/conf/deployment.toml`, ubique los protocolos TLS permitidos y las etiquetas de gateway que sincroniza API Manager.

**Resultado esperado.** El núcleo tiene WSO2, Keycloak, PostgreSQL, RabbitMQ, Consola, motores, `nexo-division` y los backends de ejemplo; `obs` y `legacy` agregan observabilidad y la plataforma existente simulada; `cont` agrega `cont-cpd`, `cont-gcp`, `cont-etcd`, `cont-coredns` y tres agentes. `PROFILES` vale `--profile obs --profile legacy`. TLS: `TLSv1.2,TLSv1.3`. Etiquetas sincronizadas: Default, Desarrollo, QA y Operadores (Publico la atiende `gw-publico`).

**Autoevaluación.**

- Cambió `POSTGRES_PASSWORD` en `.env` con el laboratorio ya creado. ¿Qué pasa y qué corresponde hacer?

<details>
<summary>Respuesta</summary>

Los servicios no conectan, porque la base y sus usuarios se crearon con la contraseña anterior al inicializar el volumen. En el laboratorio se restablece por completo (`make clean`), se levanta de nuevo y se exportan las mismas variables antes del arranque.

</details>

### Ejercicio 1.2 · Plataforma como código {#ejercicio-1-2}

**Objetivo.** Aplicar `platform.yaml` y comprobar que la operación es idempotente y que el resultado está en WSO2.

**Pasos.**

1. Aplique la plataforma dos veces y compare las salidas:

   ```bash
   make -C deploy/compose platform
   make -C deploy/compose platform
   ```

2. En el Admin Portal (`https://apim:9443/admin`) revise **Gateways** y las políticas de **Rate Limiting** (suscripción, aplicación y avanzadas).
3. Consulte los mismos datos por la Admin REST API:

   ```bash
   source tools/lab-bootstrap/ayudas-curso.sh
   curl -sk -u "admin:$APIM_ADMIN_PASSWORD" https://apim:9443/api/am/admin/v4/environments | jq -r '.list[] | "\(.name)  \(.vhosts[0].host)"'
   curl -sk -u "admin:$APIM_ADMIN_PASSWORD" https://apim:9443/api/am/admin/v4/throttling/policies/subscription | jq -r '.list[] | "\(.policyName)  \(.defaultLimit.requestCount.requestCount)/min"'
   ```

**Resultado esperado.** La primera ejecución crea los ambientes Desarrollo, QA, Operadores y Publico, los planes y las políticas, actualiza los flujos de aprobación y crea o actualiza el ruleset y las políticas de gobierno. La segunda informa «ya existe» para ambientes y planes y «sin cambios» para los flujos. Las consultas muestran los hosts `dev.nexo.lab`, `qa.nexo.lab`, `operadores.nexo.lab` y `publico.nexo.lab`, y los planes Interno (20000/min), OperadoresEstandar (600/min), OperadoresAmpliado (3000/min) y Publico (60/min), además de los planes que trae WSO2.

**Autoevaluación.**

- Después de `make platform`, ¿qué pasa al crear una aplicación nueva en el Dev Portal?

<details>
<summary>Respuesta</summary>

Queda pendiente de aprobación: los flujos de aprobación quedan activos para la creación de aplicaciones, las credenciales de producción, las suscripciones y el autorregistro. Se aprueba en Admin Portal → Tasks (se practica en M2).

</details>

### Ejercicio 1.3 · APIs del curso en las tres etapas {#ejercicio-1-3}

**Objetivo.** Desplegar APIs desde sus proyectos versionados, por etapa, y comprobar dónde quedó cada revisión.

**Pasos.**

1. Despliegue Concesiones en desarrollo, QA y producción:

   ```bash
   make -C deploy/compose deploy-apis
   ```

2. Despliegue en producción las demás APIs del curso:

   ```bash
   source tools/lab-bootstrap/ayudas-curso.sh
   for api in solicitudes-concesion consulta-publica concesiones-graphql eventos-red; do
     nexo-ctl api deploy wso2/apim/apis/$api -s prod -m "preparación del laboratorio del curso"
   done
   ```

3. Liste las APIs y abra Concesiones en el Publisher, sección de despliegues, para ver la revisión de cada gateway:

   ```bash
   nexo-ctl api list -s prod
   ```

4. Compruebe las audiencias con la verificación del laboratorio:

   ```bash
   pnpm --filter @nexo/lab-bootstrap check:audiencias
   ```

**Resultado esperado.** Cada despliegue informa «Revisión … desplegada en: …» con los gateways de su etapa: Desarrollo (`dev.nexo.lab`), QA (`qa.nexo.lab`) y, en producción, Default y Operadores para Concesiones y Publico para ConsultaPublica. `nexo-ctl api list` muestra las cinco APIs en estado `PUBLISHED`. `check:audiencias` muestra cuatro casos que cumplen (200 en la audiencia propia, 404 en la ajena) y termina con «verificado: cada audiencia recibe solo sus APIs».

**Autoevaluación.**

- ¿Por qué la API Concesiones de producción no llama directo a `concesiones-v1:7001`?

<details>
<summary>Respuesta</summary>

Porque su proyecto declara `division: { prod: true }`: en producción el gateway llama a `nexo-division`, donde el motor de despliegues progresivos cambia pesos entre versiones sin redesplegar la API (se practica en M3).

</details>

### Ejercicio 1.4 · Verificar una versión, actualizar y restablecer {#ejercicio-1-4}

**Objetivo.** Comprobar los entregables de la versión, aplicar el procedimiento de actualización y restablecer el laboratorio desde cero.

**Pasos: verificar la versión.**

1. Compruebe las sumas de los entregables y revise el SBOM:

   ```bash
   git describe --tags
   (cd release/1.0.0 && sha256sum -c CHECKSUMS.txt)
   jq -r '.metadata.component.name + " " + .metadata.component.version' release/1.0.0/sbom-nexo-1.0.0.cdx.json
   jq -r '.components[] | select(.name | test("WSO2")) | "\(.name) \(.version) \(.licenses[0].license.id)"' release/1.0.0/sbom-nexo-1.0.0.cdx.json
   ```

2. Lea en `release/1.0.0/LICENCIAS.md` cuántos componentes de terceros tiene la versión y qué componente usa una licencia AGPL.

**Pasos: actualizar.** El procedimiento de actualización del laboratorio es el mismo para cualquier etiqueta nueva; en el curso se aplica sobre la misma versión, lo que además demuestra que cada paso es idempotente.

3. Aplique el procedimiento:

   ```bash
   git fetch --tags && git checkout v1.0.0     # la etiqueta de destino
   pnpm install
   pnpm --filter @nexo/shared --filter @nexo/wso2-client build
   make -C deploy/compose up                   # reconstruye lo que cambió y recrea esos contenedores
   make -C deploy/compose bootstrap
   make -C deploy/compose platform
   make -C deploy/compose deploy-apis
   ```

**Pasos: restablecer.**

4. Detenga y levante sin borrar datos, y compruebe que la configuración sigue:

   ```bash
   make -C deploy/compose down && make -C deploy/compose up
   make -C deploy/compose status        # esperar apim y keycloak sanos
   make -C deploy/compose bootstrap
   ```

5. Restablezca por completo y repita la preparación (pasos 3 a 5 de la [preparación](./laboratorio-participante.md#preparacion)):

   ```bash
   make -C deploy/compose clean PROFILES="--profile obs --profile legacy --profile cont"
   make -C deploy/compose up
   ```

**Resultado esperado.** Los dos archivos de `CHECKSUMS.txt` responden `OK`; el SBOM corresponde a «Yago Nexo 1.0.0» e incluye WSO2 API Manager 4.7.0, Micro Integrator 4.6.0 y Universal Gateway 4.7.0 con licencia Apache-2.0; Grafana es el componente con licencia AGPL. En la actualización y después de `down` y `up`, el arranque informa «ya existe» y la prueba de punta a punta pasa. Después de `clean`, el arranque vuelve a crear todo desde cero.

**Autoevaluación.**

- ¿Qué diferencia hay entre `make down` y `make clean`, y cuál usaría antes de una evaluación?
- Un parche 1.0.1 corrige una vulnerabilidad. ¿Qué debería traer además de la corrección?

<details>
<summary>Respuestas</summary>

`down` detiene y elimina los contenedores y conserva los volúmenes; `clean` borra también los volúmenes. Antes de una evaluación, `clean` con todos los perfiles, para partir de un estado conocido. El parche debe traer su paquete de corrección y un plan de reversa, y publicar sus sumas de verificación y su SBOM.

</details>
