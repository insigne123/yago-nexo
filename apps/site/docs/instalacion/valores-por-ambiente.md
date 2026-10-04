---
title: Valores por ambiente
description: Réplicas, recursos y autoescalamiento de cada componente de Nexo en producción (CPD), respaldo (Google Cloud), QA y desarrollo; capacidad de los nodos, tamaño de PostgreSQL y Secrets que pide el chart.
---

import EstadoCapacidad from '@site/src/components/EstadoCapacidad';

# Valores por ambiente

Estado del chart: <EstadoCapacidad id="helm" />

Cada ambiente usa el mismo chart con su archivo de valores encima de `values.yaml`:

| Archivo | Ambiente | Resumen |
| --- | --- | --- |
| `values.yaml` | Base | Todas las opciones, con una réplica y recursos mínimos. Se aplica siempre. |
| `values-cpd.yaml` | Producción en el CPD | 2 réplicas de todo lo que procesa tráfico, autoescalamiento en gateways e integrador, antiafinidad obligatoria, Traefik con verificación del certificado interno, ServiceMonitors. |
| `values-gcp-dr.yaml` | Respaldo en Google Cloud | Espera tibia: cerca del 50 % de las instancias (mínimo 1) con los mismos recursos por pod, reparto por zona, Cloud DNS para la continuidad, sin aplicar esquema ni registrar el Key Manager (llegan por la replicación). |
| `values-qa.yaml` | QA | 1 instancia por servicio, recursos reducidos, datos sintéticos, almacenes de llaves de ejemplo. |
| `values-dev.yaml` | Desarrollo | Igual que QA, con sus propios nombres, reino de Keycloak y credenciales. |

Los nombres de host, direcciones y Secrets de esos archivos son de ejemplo (`*.nexo.example`). Los de cada sitio van en un archivo propio que se pasa al final (`-f sitio.yaml`) y que no lleva contraseñas.

## Producción en el CPD {#cpd}

Clúster RKE2 de 3 servidores y 11 nodos de trabajo de 8 vCPU y 32 GB (88 vCPU y 352 GB en total). En los componentes de WSO2 la solicitud es igual al límite, para que la JVM tenga siempre la CPU y la memoria que espera.

| Componente | Réplicas | CPU (solicitud / límite) | Memoria | Autoescalamiento |
| --- | --- | --- | --- | --- |
| Control Plane de API Manager | 2 | 4 / 4 | 8 GiB (heap 4 a 5 GB) | No |
| Traffic Manager | 2 | 2 / 2 | 4 GiB | No |
| Gateway `operadores` | 2 | 2 / 2 | 4 GiB | 2 a 4, al 70 % de CPU |
| Gateway `publico` | 2 | 2 / 2 | 4 GiB | 2 a 4, al 70 % de CPU |
| Micro Integrator | 2 | 2 / 2 | 4 GiB | 2 a 4, al 70 % de CPU |
| nexo-division (Envoy) | 2 | 0,5 / 1 | 512 MiB | No |
| API de la Consola | 2 | 0,5 / 1 | 1 GiB | No |
| Web de la Consola | 2 | 0,05 / 0,25 | 64 / 128 MiB | No |
| Motores | 2 | 0,5 / 1 | 1 GiB | No (una réplica lidera cada motor; la otra espera) |
| Agente de continuidad | 1 | 0,1 / 0,5 | 256 MiB | No |
| Fluent Bit junto a Control Plane y gateways | 6 | 0,05 / 0,2 | 64 / 128 MiB | Sigue a su pod |

El Traffic Manager no estaba en el dimensionamiento inicial: se agregó con 2 réplicas de 2 vCPU y 4 GB porque API Manager 4.7.0 lo distribuye aparte del Control Plane y los gateways lo necesitan para los límites de uso.

### Dependencias {#dependencias}

No las instala el chart, pero corren en los mismos nodos si se alojan en el clúster:

| Servicio | Instancias | CPU | Memoria | Almacenamiento |
| --- | --- | --- | --- | --- |
| PostgreSQL (primaria y réplica) | 2 | 4 | 16 GB | 500 GiB de datos + 50 GiB de WAL |
| RabbitMQ (colas quorum) | 3 | 2 | 4 GB | según colas |
| OpenSearch | 3 | 4 | 16 GB | según retención de analítica |
| Keycloak | 2 | 2 | 4 GB | — |
| Prometheus | 1 | 2 (supuesto) | 8 GB (supuesto) | según retención |
| Grafana | 1 | 0,5 (supuesto) | 1 GB (supuesto) | — |
| OpenTelemetry Collector y Jaeger | 1 + 1 | 1 + 1 (supuesto) | 2 + 2 GB (supuesto) | — |
| Fluent Bit (DaemonSet) | 1 por nodo | 0,1 | 128 MB | — |

Los valores marcados como *supuesto* no venían en el dimensionamiento entregado y se ajustan con la carga real.

### Capacidad {#capacidad}

| | CPU solicitada | Memoria solicitada |
| --- | --- | --- |
| Chart, carga normal | 27,5 vCPU | 54 GiB |
| Dependencias en el clúster | 35,6 vCPU | 114 GB |
| **Total, carga normal** | **63 vCPU (72 % de 88)** | **168 GB (48 % de 352)** |
| Gateways e integrador en el máximo del autoescalamiento | +12 vCPU | +24 GiB |
| **Total, máximo** | **75 vCPU (85 %)** | **192 GB (55 %)** |

A eso se suma lo que reserva cada nodo para Kubernetes (cerca de 0,5 vCPU y 1 GB). Por eso el máximo de los autoescalamientos es 4: si la carga pide más, primero se agregan nodos de trabajo.

### Tamaño de PostgreSQL {#postgresql}

Los 500 GiB salen de la retención de la auditoría, que es lo que más crece (cada acción en la plataforma queda como un evento encadenado en la base `nexo`):

| Parte | Estimación |
| --- | --- |
| Auditoría: 500.000 eventos al día × 1 KiB por evento (fila e índices) × 730 días en línea | 348 GiB |
| API Manager (`apim_db` y `shared_db`) | 40 GiB |
| Integrador (`mi_db`) | 10 GiB |
| Margen para índices, mantenimiento (vacuum) y crecimiento: 25 % | 100 GiB |
| **Total** | **≈ 500 GiB** |

Es una estimación: con la retención y el volumen que fije la institución se recalcula con la misma fórmula y se cambia `postgresql.cloudnativepg.almacenamiento.tamano` (o el volumen del PostgreSQL externo). El WAL va en un volumen aparte de 50 GiB.

## Respaldo en Google Cloud {#gcp}

Espera tibia: la mitad de las instancias del CPD, con un mínimo de una por componente y los mismos recursos por pod.

| Componente | Réplicas en espera | Autoescalamiento al conmutar |
| --- | --- | --- |
| Control Plane | 1 | No |
| Traffic Manager | 1 | No |
| Gateway `operadores` | 1 | 1 a 4, al 60 % de CPU |
| Gateway `publico` | 1 | 1 a 4, al 60 % de CPU |
| Micro Integrator | 1 | 1 a 2, al 60 % de CPU |
| nexo-division, API y web de la Consola, motores | 1 cada uno | No |
| Agente de continuidad | 1 | No |
| PostgreSQL | 1 réplica en espera | — |

En espera, el chart pide unas 14 vCPU y 27 GiB, más la réplica de PostgreSQL. El grupo de nodos `plataforma` de OpenTofu parte con 2 nodos por zona (6 nodos de 8 vCPU y 32 GB) y puede crecer hasta 4 por zona. Los gateways bajan el umbral de autoescalamiento al 60 % para subir antes cuando el sitio recibe el tráfico.

## QA y desarrollo {#qa-dev}

Una instancia de cada servicio en un clúster no productivo, cada ambiente en su espacio de nombres (`nexo-qa`, `nexo-dev`):

| Componente | CPU (solicitud / límite) | Memoria |
| --- | --- | --- |
| Control Plane | 1 / 2 | 3 GiB |
| Traffic Manager | 0,25 / 1 | 1,5 GiB |
| Gateways (cada uno) | 0,5 / 1 | 2 GiB |
| Micro Integrator | 0,25 / 1 | 1,5 GiB |
| nexo-division | 0,1 / 0,5 | 128 / 256 MiB |
| API de la Consola y motores (cada uno) | 0,1 / 0,5 | 256 / 512 MiB |
| Web de la Consola | 0,05 / 0,25 | 64 / 128 MiB |

Cada ambiente pide unas 3 vCPU y 11 GiB. Usa los almacenes de llaves de ejemplo de WSO2, por lo que el TLS interno no se verifica: solo para datos sintéticos.

## Secrets {#secrets}

El chart solo referencia Secrets que ya existen en el espacio de nombres (`secretos.*.existingSecret`); ningún archivo de valores lleva contraseñas.

| Secret (nombre por omisión) | Claves | Uso |
| --- | --- | --- |
| `nexo-apim` | `admin-password`, `encryption-key` | Administrador de API Manager y llave de cifrado interna (32 bytes en hexadecimal, la misma en ambos sitios, no cambia) |
| `nexo-bd-apim` | `password` (y `username` con CloudNativePG) | Usuario `apimadmin` de `apim_db` y `shared_db` |
| `nexo-bd-mi` | `password` (y `username`) | Usuario `mi` de `mi_db` |
| `nexo-bd-nexo` | `password` (y `username`) | Usuario `nexo` de la base de la Consola y los motores |
| `nexo-mi` | `admin-password` | Management API del integrador |
| `nexo-rabbitmq` | `password` | Usuario `nexo` de RabbitMQ |
| `nexo-keycloak-km` | `client-secret` | Cliente técnico `wso2-km` de Keycloak |
| `nexo-wso2-almacen` | `wso2carbon.jks`, `client-truststore.jks`, `keystore-password` | Almacenes de llaves de WSO2 (producción y respaldo) |
| `nexo-ca-interna` | `ca.crt` | CA de los certificados internos de WSO2 |
| `nexo-tls` | `tls.crt`, `tls.key` | Certificado de los nombres públicos |
| `nexo-opensearch` | `username`, `password` | OpenSearch con seguridad activa |
| `nexo-continuidad` | `primary-db-url`, `replica-db-url` y `gcp-sa-key` (Google Cloud) o `tsig.key` (DNS de la institución) | Agente de continuidad |
| `harbor-nexo` | `.dockerconfigjson` | Descarga de imágenes del registro del CPD |

Las contraseñas que van dentro de la URL de PostgreSQL (usuario `nexo`) deben usar solo letras, dígitos, `-` y `_`. La gestión centralizada con OpenBao y External Secrets está en estado <EstadoCapacidad id="secretos" />.
