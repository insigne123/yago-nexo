# Inventario de licencias · Yago Nexo 1.0.0

Generado el 2026-10-04 a partir del SBOM CycloneDX (`sbom-nexo-1.0.0.cdx.json`).
Total de componentes de terceros: **1786** (22 de ejecución + 1764 de npm), en **21** licencias distintas.

Yago Nexo es software propietario de Sociedad de Inversiones Yago SpA, construido sobre una base de código
abierto. Cada componente de terceros conserva su propia licencia. Ningún componente incrustado en el código
propio usa copyleft fuerte; Grafana (AGPL‑3.0) se ejecuta como servicio separado y sin modificaciones.

| Licencia | Componentes |
| --- | --- |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| (MIT AND Zlib) | 1 |
| (MIT OR CC0-1.0) | 4 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (WTFPL OR MIT) | 2 |
| 0BSD | 4 |
| AGPL-3.0-only | 1 |
| Apache-2.0 | 104 |
| BSD-2-Clause | 31 |
| BSD-3-Clause | 28 |
| BlueOak-1.0.0 | 3 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 3 |
| ISC | 91 |
| MIT | 1433 |
| MIT-0 | 64 |
| MPL-1.1 | 1 |
| MPL-2.0 | 7 |
| PostgreSQL | 1 |
| Python-2.0 | 1 |
| Unlicense | 4 |

## Componentes de ejecución

| Componente | Versión | Licencia | Rol |
| --- | --- | --- | --- |
| WSO2 API Manager | 4.7.0 | Apache-2.0 | Plano de control, Traffic Manager y gateway (base abierta) |
| WSO2 Micro Integrator | 4.6.0 | Apache-2.0 | Integración y mediación (base abierta) |
| WSO2 Universal Gateway | 4.7.0 | Apache-2.0 | Gateway dedicado por audiencia |
| Keycloak | 26.8 | Apache-2.0 | Identidad y Key Manager (SSO institucional) |
| PostgreSQL | 16 | PostgreSQL | Base de datos de la Consola, WSO2 y el Integrador |
| Envoy | 1.38.5 | Apache-2.0 | nexo-division: división de tráfico de los despliegues progresivos (D-04) |
| RabbitMQ | 4.3 | MPL-2.0 | Mensajería con colas de reintento y cola de fallidos |
| OpenSearch | 3.9.0 | Apache-2.0 | Analítica del gateway y almacén del SIEM de laboratorio |
| OpenSearch Dashboards | 3.9.0 | Apache-2.0 | Exploración de la analítica |
| Prometheus | 3.13.4 | Apache-2.0 | Métricas de la plataforma y de los motores |
| Alertmanager | 0.34.1 | Apache-2.0 | Enrutamiento de alertas a la mesa y al SIEM |
| Grafana | 13.0.10 | AGPL-3.0-only | Tableros (se ejecuta sin modificaciones, como servicio separado) |
| OpenTelemetry Collector (contrib) | 0.161.0 | Apache-2.0 | Recolección de trazas |
| Jaeger | 2.21.0 | Apache-2.0 | Trazas de extremo a extremo |
| Fluent Bit | 5.1.3 | Apache-2.0 | Envío de logs y métricas; receptor syslog del SIEM |
| etcd | 3.6.5 | Apache-2.0 | Anclaje de quórum de los agentes de continuidad (D-05) |
| CoreDNS | 1.12.0 | Apache-2.0 | Resolución del sitio activo en el laboratorio de continuidad |
| Apache APISIX | 3.19.0 | Apache-2.0 | Plataforma "actual" simulada para el descubrimiento (D-01) |
| NGINX | 1.27 | BSD-2-Clause | Plataforma "actual" simulada para el descubrimiento (D-01) |
| PostgreSQL JDBC Driver | 42.7.13 | BSD-2-Clause | Controlador JDBC empacado en las imágenes WSO2 |
| rgxgen | 1.4 | Apache-2.0 | Biblioteca empacada en WSO2 API Manager |
| JMX Prometheus Java Agent | 1.0.1 | Apache-2.0 | Exportador JMX empacado en WSO2 API Manager |
