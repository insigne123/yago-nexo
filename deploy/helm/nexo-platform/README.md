# Chart nexo-platform

Chart paraguas de Yago Nexo: un solo release instala toda la plataforma en un espacio de nombres de
Kubernetes. Cada componente se activa o desactiva por valores (`<componente>.enabled`). No depende de charts
remotos, así que se instala igual en el CPD sin salida a Internet y en Google Cloud.

Estado: **en desarrollo**. Pasa `helm lint` y la validación de esquemas (`deploy/validar-instaladores.sh`),
pero todavía no se instala en un clúster real.

## Qué instala

| Componente | Recurso | Imagen por omisión | Puertos |
| --- | --- | --- | --- |
| Control Plane de WSO2 API Manager 4.7.0 (Publisher, Developer Portal, Admin, Key Manager, centro de eventos) | StatefulSet `apim-cp` + Ingress | `nexo/apim-cp:4.7.0` | 9443, 5672, 9611, 9711 |
| Traffic Manager 4.7.0 (límites de uso) | StatefulSet `apim-tm` | `nexo/apim-tm:4.7.0` | 9443, 5672, 9611, 9711 |
| Universal Gateway 4.7.0, uno por audiencia (`operadores` y `publico`) | Deployment `gw-<audiencia>` + Service + Ingress + HPA | `nexo/apim-gateway:4.7.0` | 8243, 8280, 8099, 9099 |
| Micro Integrator 4.6.0 | Deployment `mi` + HPA | `nexo/mi:4.6.0` | 8290, 8253, 9164, 9201 |
| nexo-division (Envoy, división de tráfico por xDS) | StatefulSet `division` | `envoyproxy/envoy:v1.38.5` | 10000, 9902 |
| API de la Consola | Deployment `console-api` | `nexo/console-api:<appVersion>` | 8090 |
| Web de la Consola | Deployment `console-web` + Ingress (con la API en `/api`) | `nexo/console-web:<appVersion>` | 8080 |
| Motores (despliegues, guardián, descubrimiento, SIEM) y plano de control xDS | Deployment `motores` | `nexo/motores:<appVersion>` | 9465, 9466 |
| Agente de continuidad del sitio | Deployment `continuidad` (1 réplica) | `nexo/motores:<appVersion>` | 9465 |
| Registro de Keycloak como Key Manager | Job post-install/post-upgrade | `nexo/motores:<appVersion>` | — |
| Fluent Bit junto a Control Plane y gateways (analítica, auditoría y registros hacia OpenSearch) | contenedor adicional | `fluent/fluent-bit:5.1.3` | 2020, 2021 |
| PostgreSQL con CloudNativePG (opcional) | `Cluster` y `Database` de CloudNativePG | `ghcr.io/cloudnative-pg/postgresql:16` | 5432 |

Además: ConfigMaps con los `deployment.toml` generados desde los valores, PodDisruptionBudget por
componente, antiafinidad entre réplicas, sondas de inicio, vida y disponibilidad, NetworkPolicies (todo
denegado por omisión y solo los flujos necesarios) y ServiceMonitors opcionales.

Todas las imágenes salen de `global.imageRegistry`. Las `nexo/*` las construye Yago con la misma receta del
laboratorio (`deploy/compose/*/Dockerfile`): imagen oficial de WSO2 más el controlador JDBC de PostgreSQL y el
exportador JMX de Prometheus; `nexo/apim-dbinit` lleva los scripts SQL oficiales de API Manager. Envoy y
Fluent Bit se usan sin cambios, copiados al registro del sitio.

## Lo que el chart no instala

Se consumen como servicios externos (`global.dependencias`): PostgreSQL (o CloudNativePG con el operador ya
instalado), RabbitMQ, OpenSearch, Keycloak de la institución, Prometheus y Alertmanager, el colector de
OpenTelemetry y el etcd del quórum de continuidad. El testigo de continuidad corre fuera de Kubernetes.

## Archivos de valores

| Archivo | Uso |
| --- | --- |
| `values.yaml` | Todas las opciones con valores mínimos (1 réplica). Se usa siempre. |
| `values-cpd.yaml` | Producción en el CPD: 2 réplicas de todo, HPA en gateways e integrador, Traefik de RKE2. |
| `values-gcp-dr.yaml` | Respaldo en GKE: espera tibia (~50 %, mínimo 1), reparto por zona, Cloud DNS para la continuidad. |
| `values-qa.yaml` | QA: 1 instancia por servicio, recursos reducidos, almacenes de llaves de ejemplo. |
| `values-dev.yaml` | Desarrollo: igual que QA, con sus propios nombres y credenciales. |

Los nombres de host, IP y Secrets de esos archivos son de ejemplo (`*.nexo.example`). Los del sitio van en un
archivo propio que se pasa al final con `-f`.

## Secrets que deben existir antes de instalar

El chart nunca crea ni guarda contraseñas: solo referencia Secrets existentes (`secretos.*.existingSecret`).

| Secret (por omisión) | Claves | Para qué |
| --- | --- | --- |
| `nexo-apim` | `admin-password`, `encryption-key` | Administrador de API Manager y llave de cifrado (32 bytes en hexadecimal, igual en ambos sitios) |
| `nexo-bd-apim` | `password` (+ `username` con CloudNativePG) | Usuario `apimadmin` de `apim_db` y `shared_db` |
| `nexo-wso2-almacen` | `wso2carbon.jks`, `client-truststore.jks`, `keystore-password` | Almacenes de llaves de WSO2 (producción) |
| `nexo-mi` | `admin-password` | Management API del integrador |
| `nexo-bd-mi` | `password` (+ `username`) | Usuario `mi` de `mi_db` |
| `nexo-bd-nexo` | `password` (+ `username`) | Usuario `nexo` de la base `nexo` (Consola y motores) |
| `nexo-rabbitmq` | `password` | Usuario `nexo` de RabbitMQ |
| `nexo-keycloak-km` | `client-secret` | Cliente técnico `wso2-km` de Keycloak |
| `nexo-opensearch` (opcional) | `username`, `password` | OpenSearch con seguridad activa |
| `nexo-continuidad` | `primary-db-url`, `replica-db-url`, `gcp-sa-key` o `tsig.key` | Agente de continuidad |
| `nexo-ca-interna` | `ca.crt` | CA que firma los certificados internos de WSO2 |
| `nexo-tls` | `tls.crt`, `tls.key` | Certificado de los nombres públicos (Ingress) |
| `harbor-nexo` | `.dockerconfigjson` | Descarga de imágenes del registro del CPD |

Las contraseñas que van dentro de una URL de PostgreSQL (`nexo`) no deben llevar caracteres reservados de URL
(use letras, dígitos, `-` y `_`).

## Instalar

```bash
helm upgrade --install nexo-platform deploy/helm/nexo-platform \
  --namespace nexo --create-namespace \
  -f deploy/helm/nexo-platform/values-cpd.yaml \
  -f sitio-cpd.yaml \
  --wait --timeout 30m
```

En el CPD lo hace el playbook `deploy/ansible/rke2` (rol `nexo_plataforma`). La guía completa, con
verificación y vuelta atrás, está en el sitio de Nexo: *Instalación*.

## Decisiones de diseño

- **Control Plane y Traffic Manager como StatefulSet.** Los gateways se suscriben al centro de eventos de cada
  nodo y envían los eventos de límites a cada Traffic Manager por su nombre DNS estable
  (`<nodo>.<servicio>-pares`). Un contenedor de inicio completa en cada nodo la lista de los otros nodos.
- **Un gateway por audiencia.** Cada gateway sincroniza solo las APIs desplegadas en sus ambientes; `operadores`
  atiende `Default` (interna) y `Operadores`, y `publico` atiende `Publico`, igual que en el laboratorio.
- **Keycloak como Key Manager por API.** WSO2 4.x registra los Key Manager externos por la Admin REST API, no
  en `deployment.toml`; el Job hace lo mismo que el arranque del laboratorio y es idempotente.
- **Registros de WSO2 con Fluent Bit al lado.** WSO2 escribe la analítica en archivos; un Fluent Bit en el
  mismo pod los lee de un volumen compartido, sin montar carpetas del nodo (compatible con Pod Security
  "restricted", que aplica el perfil CIS de RKE2).
- **TLS interno.** Traefik habla HTTPS con WSO2 y verifica su certificado con la CA interna (ServersTransport).
  El certificado de WSO2 debe incluir el nombre `global.ingress.traefik.serversTransport.serverName` y los
  nombres de servicio internos que usan la Consola y los motores.
