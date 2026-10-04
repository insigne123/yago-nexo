---
title: Laboratorio del participante
sidebar_label: Laboratorio del participante
description: Cómo obtiene, prepara, inicia, restablece y comprueba cada participante su propio laboratorio de Yago Nexo para la capacitación, y qué equipo necesita.
---

import Accesos from '../_generated/accesos-laboratorio.md';
import Hosts from '../_generated/hosts-laboratorio.md';
import EstadoCapacidad from '@site/src/components/EstadoCapacidad';

# Laboratorio del participante

Estado del laboratorio: <EstadoCapacidad id="laboratorio" />

Cada participante trabaja en **su propia copia** del laboratorio de Nexo: el mismo Docker Compose de `deploy/compose` que describe la página [Laboratorio](../laboratorio.md), más la preparación que necesitan los ejercicios del curso. Nadie comparte su ambiente: lo que un participante rompe o cambia no afecta a los demás.

:::caution Solo para práctica

El laboratorio usa credenciales de ejemplo, el certificado autofirmado de WSO2 y Keycloak en modo desarrollo (HTTP). No lo exponga a redes no confiables ni cargue datos reales.

:::

## Un equipo por participante {#equipo}

El Compose fija el nombre de proyecto `nexo-lab` y publica puertos fijos (9443, 8243, 8080, 15432 y otros). Por eso **en un equipo cabe un solo laboratorio**, y cada participante necesita su propio equipo o máquina virtual.

| Modalidad | Cómo se usa |
| --- | --- |
| Equipo Linux propio o máquina virtual con escritorio | El laboratorio y el navegador corren en el mismo equipo. Es la modalidad recomendada: los portales redirigen a los nombres `apim` y `keycloak`, que resuelven a `127.0.0.1`. |
| Máquina virtual sin escritorio | El participante se conecta por SSH con reenvío de los puertos que usa el curso y agrega en su propio equipo la misma línea de `/etc/hosts` que agrega `make hosts`. |

Ejemplo de conexión con reenvío de puertos (modalidad sin escritorio):

```bash
ssh -L 9443:localhost:9443 -L 8243:localhost:8243 -L 18243:localhost:18243 \
    -L 8080:localhost:8080 -L 8090:localhost:8090 -L 3000:localhost:3000 \
    -L 9090:localhost:9090 -L 16686:localhost:16686 -L 5601:localhost:5601 \
    -L 15672:localhost:15672 participante@<máquina-del-laboratorio>
```

### Equipo recomendado {#requisitos}

:::info Estimación para el curso

Todavía no hay una medición publicada de requisitos mínimos del laboratorio. Estos valores son la referencia de Yago para el curso, con todos los perfiles (`obs`, `legacy` y `cont`) arriba a la vez.

:::

| Recurso | Recomendado para el curso |
| --- | --- |
| Procesador | 8 vCPU (x86-64) |
| Memoria | 16 GB |
| Disco | 60 GB libres en SSD (imágenes, volúmenes y dependencias) |
| Sistema | Linux con Docker Engine y Docker Compose v2 |
| Red | Internet la primera vez (imágenes de contenedores y controladores que se agregan a las imágenes de WSO2); luego basta la red local |

Software:

- Docker Engine con Docker Compose v2 (`docker compose`), Git y GNU Make.
- Node.js 22 o superior y pnpm 10 (`corepack enable` activa la versión que declara el repositorio).
- `curl`, `jq` y `openssl` para los ejercicios.
- Permisos de administrador (sudo) solo para `make hosts`.

Si el equipo es más justo, levante el laboratorio de continuidad (perfil `cont`) solo durante M6 y deténgalo después (ver [Detener y reanudar](#detener)). Para ver el consumo real: `docker stats --no-stream`.

## Obtener el laboratorio {#obtener}

El instructor entrega a cada participante el acceso al repositorio de Nexo y la etiqueta de la versión del curso. La copia del participante no incluye el material de evaluación (`tools/certificacion`).

```bash
git clone <URL que entrega el instructor> yago-nexo
cd yago-nexo
git checkout v1.0.0      # etiqueta de la versión del curso
```

## Preparación (una vez) {#preparacion}

Desde la raíz del repositorio. La primera vez toma más tiempo porque descarga imágenes y API Manager tarda varios minutos en quedar sano.

```bash
# 1. Dependencias y bibliotecas que usan los backends, el arranque y nexo-ctl
corepack enable
pnpm install
pnpm --filter @nexo/shared --filter @nexo/wso2-client build

# 2. Variables y nombres del laboratorio
cp deploy/compose/.env.example deploy/compose/.env
make -C deploy/compose hosts          # pide sudo una sola vez

# 3. Construir y levantar núcleo + perfiles obs y legacy
make -C deploy/compose up
make -C deploy/compose status         # repetir hasta ver apim y keycloak "(healthy)"

# 4. WSO2 y Keycloak, plataforma como código y APIs del curso
make -C deploy/compose bootstrap      # Key Manager, API Concesiones, aplicación OperadorDemo y prueba de punta a punta
make -C deploy/compose platform       # ambientes de gateway, planes de uso, aprobaciones y gobierno
make -C deploy/compose deploy-apis    # Concesiones en dev, qa y prod

source tools/lab-bootstrap/ayudas-curso.sh
for api in solicitudes-concesion consulta-publica concesiones-graphql eventos-red; do
  nexo-ctl api deploy wso2/apim/apis/$api -s prod -m "preparación del laboratorio del curso"
done

# 5. Plataforma existente simulada (perfil legacy) para el descubrimiento
make -C deploy/compose legado
```

Resultado esperado:

- `make bootstrap` termina con estas dos líneas (el total depende de los datos sintéticos):

  ```text
  [bootstrap] PRUEBA DE PUNTA A PUNTA OK: gateway → backend {"status":200,"total":<n>,"version":"1.0.0"}
  [bootstrap] Sin token el gateway rechaza la llamada {"status":401}
  ```

- Cada `nexo-ctl api deploy` informa la revisión desplegada y, la primera vez, «API publicada en el portal de desarrolladores».
- `make legado` informa la ruta de APISIX creada y las llamadas registradas en el NGINX heredado.

El laboratorio de continuidad de dos sitios se levanta recién en M6, con `make -C deploy/compose continuidad`.

## Ayudas del curso {#ayudas}

`tools/lab-bootstrap/ayudas-curso.sh` define funciones de terminal que abrevian lo que se repite en los ejercicios. No cambian el laboratorio. Se cargan en cada terminal nueva, desde la raíz del repositorio:

```bash
source tools/lab-bootstrap/ayudas-curso.sh
```

| Ayuda | Qué hace | Ejemplo |
| --- | --- | --- |
| `tok <usuario>` | Token de una persona del realm `nexo` (cliente `nexo-console`). | `tok luis.aprobador` |
| `consola <usuario> <método> <ruta> [json]` | Llama a la API de la Consola (`http://localhost:8090/api/v1`) como esa persona. | `consola carla.operacion GET /engines` |
| `consola_estado …` | Igual que `consola`, pero muestra solo el código HTTP. | `consola_estado ana.desarrollo GET /audit-events` |
| `app_llaves [aplicación]` | Consumer key y consumer secret de producción (Keycloak) de una aplicación del Dev Portal. | `app_llaves OperadorDemo` |
| `app_tok [aplicación]` | Token `client_credentials` de esa aplicación. | `APP=$(app_tok OperadorDemo)` |
| `nexo-ctl …` | CLI de Nexo desde la raíz del repositorio. | `nexo-ctl api list -s prod` |
| `mi_api <ruta>` | Management API de Micro Integrator (puerto 9164). | `mi_api /apis` |
| `caos <proporción> [puerto]` | Falla simulada de un backend de ejemplo: `1` falla todo, `0` vuelve a la normalidad. Puerto 7001 (versión 1.0.0) o 7011 (versión 1.1.0). | `caos 1` |

Las ayudas cargan las credenciales de `deploy/compose/.env`. La clave de los usuarios de ejemplo del realm es la misma que usan los scripts de verificación (variable `NEXO_LAB_USER_PASSWORD`).

### Personas del realm de laboratorio {#personas}

| Usuario | Rol en la Consola |
| --- | --- |
| `admin.nexo` | administrador |
| `ana.desarrollo` | desarrollador |
| `luis.aprobador` | aprobador |
| `carla.operacion` | operador |
| `pedro.auditoria` | auditor |
| `consumidor.demo` | consumidor |

Los roles llegan en el token desde el grupo de Keycloak de cada persona. Qué puede hacer cada rol está en la [matriz rol-permiso](../seguridad.md#matriz-rol-permiso).

## Accesos {#accesos}

<Accesos />

- Las URL con `apim`, `keycloak` y los hosts virtuales `*.nexo.lab` necesitan la línea de `/etc/hosts`:

<Hosts />

- **API de la Consola:** `http://localhost:8090/api/v1` (`/health` responde sin token).
- **Gateway de la audiencia pública:** `https://publico.nexo.lab:18243`.
- **Portales de WSO2:** usuario `admin` y la contraseña `APIM_ADMIN_PASSWORD` de `deploy/compose/.env`. Keycloak (`admin` y `KEYCLOAK_ADMIN_PASSWORD`), Grafana (`admin` y `GRAFANA_ADMIN_PASSWORD`) y RabbitMQ (`nexo` y `RABBITMQ_PASSWORD`) siguen la misma regla.

### Consola Nexo web (opcional) {#consola-web}

Algunos ejercicios se pueden hacer también desde la interfaz web de la Consola, con el Keycloak del laboratorio:

1. En `apps/console-web/public/config.json`, cambie `"provider": "mock"` por `"provider": "oidc"` (el bloque `oidc` ya apunta al realm `nexo`).
2. Inicie la interfaz apuntando a la API de la Consola del laboratorio:

   ```bash
   NEXO_API_URL=http://localhost:8090 pnpm --filter @nexo/console-web dev
   ```

3. Abra `http://localhost:5173` e ingrese con una de las personas del realm.
4. Al terminar, deje el archivo como estaba: `git checkout apps/console-web/public/config.json`.

## Comprobar el laboratorio {#comprobar}

**Comprobación rápida** (un par de minutos):

```bash
make -C deploy/compose status                 # todos "Up"; apim, keycloak, postgres, rabbitmq y opensearch "(healthy)"
make -C deploy/compose bootstrap              # termina con PRUEBA DE PUNTA A PUNTA OK y el 401 sin token
curl -s http://localhost:8090/api/v1/health   # {"status":"ok",…,"ambiente":"Laboratorio Yago"}
```

**Verificaciones completas.** El laboratorio trae scripts que comprueban cada capacidad de punta a punta. Se ejecutan con `pnpm --filter @nexo/lab-bootstrap <script>` y terminan con código 0 si todo cumple.

| Script | Qué verifica | Requiere | Cambia el laboratorio |
| --- | --- | --- | --- |
| `check:audiencias` | Cada gateway expone solo las APIs de su audiencia. | Preparación completa | Si falta, suscribe OperadorDemo a ConsultaPublica y aprueba las suscripciones pendientes. |
| `check:integracion` | Flujo de solicitudes por el gateway: 202, repetición idempotente, 422 y traza en Jaeger. | Preparación completa y perfil `obs` | Si falta, suscribe OperadorDemo a SolicitudesConcesion y aprueba las suscripciones pendientes. |
| `check:d06` | API GraphQL y API de eventos (WebSocket) a través del gateway. | Preparación completa | Si falta, suscribe OperadorDemo a esas APIs; siempre aprueba las suscripciones pendientes. |
| `check:d07` | SDK generados desde el contrato publicado (al menos tres lenguajes). | Preparación completa | Deja los zip en `out/sdk`. |
| `check:consola` | API de la Consola: roles, catálogo, impacto, consumo, TLS, mensajes fallidos, alertas, exportación y auditoría. | Preparación completa y perfil `obs` | Crea y detiene un despliegue, provoca y reprocesa un mensaje fallido y altera un evento de auditoría que luego restaura. |
| `check:d01` | Descubrimiento de APIs no gobernadas, puntaje de exposición, clasificación y reportes. | Perfil `legacy` y `make legado` | Clasifica un hallazgo como «en migración». |
| `check:d02` | Guardián de anomalías: bloqueo automático, bloqueo con aprobación, vencimiento y liberación. | Perfil `obs` | Desactiva las reglas activas durante la prueba y las restaura; deja sus reglas desactivadas. |
| `check:d04` | Despliegues progresivos con reversa automática y sin errores para los consumidores. | `make deploy-apis` | Termina con la API Concesiones de vuelta en la versión 1.0.0. |
| `check:siem` | Auditoría entregada al SIEM sin pérdida, en orden y sin duplicados. | Perfil `obs` | Detiene y vuelve a iniciar Fluent Bit. |
| `check:d05` | Quórum, conmutación automática con RTO medido y retorno guiado. | `make continuidad` | Detiene y vuelve a iniciar contenedores del laboratorio de continuidad. |

Las verificaciones `check:d02`, `check:d04` y `check:d05` generan tráfico o detienen servicios y toman varios minutos. Ninguna verificación debe correr mientras hace otro ejercicio: algunas aprueban solicitudes pendientes o cambian estados que el ejercicio espera.

## Detener y reanudar {#detener}

```bash
make -C deploy/compose down     # detiene el núcleo y los perfiles obs y legacy; conserva los datos
make -C deploy/compose up       # vuelve a levantarlos (reconstruye solo lo que cambió)
```

El laboratorio de continuidad tiene su propio perfil. Para detenerlo o verlo, agregue el perfil `cont` a la variable `PROFILES`:

```bash
make -C deploy/compose status PROFILES="--profile obs --profile legacy --profile cont"
make -C deploy/compose down   PROFILES="--profile obs --profile legacy --profile cont"
```

## Restablecer {#restablecer}

De menos a más, según lo que haya que recuperar:

| Situación | Qué hacer |
| --- | --- |
| Un servicio no responde | `cd deploy/compose && docker compose --env-file .env restart <servicio>` y revisar `make -C deploy/compose logs S=<servicio>`. |
| Quedó una falla simulada activa | `caos 0` y `caos 0 7011`. |
| Hay que volver al estado de fábrica | Borrar todo y repetir la [preparación](#preparacion) desde el paso 3. |

Restablecimiento completo (borra bases de datos, colas e índices de todos los perfiles):

```bash
make -C deploy/compose clean PROFILES="--profile obs --profile legacy --profile cont"
make -C deploy/compose up
# luego, los pasos 4 y 5 de la preparación
```

Al inicio de M7, el evaluador restablece cada laboratorio para que la evaluación práctica parta de un estado conocido (ver [M7](./m7-evaluacion.md)). Para ensayar antes, use el [ejercicio 7.1](./m7-evaluacion.md#ejercicio-7-1).

## Problemas frecuentes {#problemas}

- **El arranque no encuentra Keycloak o API Manager.** Falta `make hosts` o API Manager todavía está iniciando: revise `make -C deploy/compose status` y vuelva a ejecutar `make bootstrap`, que es idempotente.
- **`nexo-ctl` dice «Falta la variable de entorno APIM_ADMIN_PASSWORD».** Cargue las ayudas (`source tools/lab-bootstrap/ayudas-curso.sh`), que leen `deploy/compose/.env`.
- **`nexo-ctl` no encuentra `@nexo/wso2-client`.** Falta compilar las bibliotecas (paso 1 de la preparación).
- **Cambió contraseñas en `.env` y nada conecta.** Las bases se crean solo al inicializar el volumen: restablezca por completo.
- Más casos en [Laboratorio · Solución de problemas](../laboratorio.md#solución-de-problemas).
