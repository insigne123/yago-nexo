---
title: Ciclo de vida y soporte
description: Versionado semántico de Yago Nexo, política de soporte y parches, canales de soporte y niveles de servicio estándar por severidad.
---

import SeveridadEjemplos from './_generated/severidad-ejemplos.md';
import Contacto from '@site/src/components/Contacto';
import EstadoCapacidad from '@site/src/components/EstadoCapacidad';
import VersionActual from '@site/src/components/VersionActual';

# Ciclo de vida y soporte

Versión actual: <VersionActual />.

## Versiones {#versiones}

Nexo usa **versionado semántico** (`MAYOR.MENOR.PARCHE`):

| Cambio | Qué significa | Ejemplo |
| --- | --- | --- |
| Mayor | Cambios incompatibles: exige revisar integraciones o configuración. | 1.4.2 → 2.0.0 |
| Menor | Funciones nuevas compatibles con la versión anterior. | 1.4.2 → 1.5.0 |
| Parche | Correcciones, incluidas las de seguridad, sin funciones nuevas. | 1.4.2 → 1.4.3 |

Las versiones **0.x** son preliminares: sirven para evaluación y laboratorio, no para producción, y entre ellas puede haber cambios incompatibles. Cada versión se anuncia en [Novedades](/novedades) con sus cambios.

## Política de soporte {#politica-de-soporte}

- **Cada versión menor recibe correcciones de seguridad durante 12 meses** desde su publicación.
- Las correcciones se entregan como **versiones de parche**. Cada parche incluye su paquete de corrección y un **plan de reversa** para volver a la versión anterior si algo falla.
- El fin de soporte de cada versión menor se anuncia en [Novedades](/novedades).

### Parches de la base abierta {#parches}

Para los componentes de terceros (WSO2 API Manager, Micro Integrator, Keycloak y los demás de [Componentes y licencias](./componentes-y-licencias.md)), Yago sigue los avisos de seguridad de cada proyecto y de bases públicas de vulnerabilidades. Cuando corresponde, aplica la corrección en un parche de Nexo, compilando desde el código fuente si el proyecto todavía no publica una versión corregida.

La automatización de versiones, el SBOM y la firma de cada entrega están en estado <EstadoCapacidad id="sbom" />.

## Canales de soporte {#canales}

| Canal | Uso | Estado |
| --- | --- | --- |
| Mesa de soporte web | Tickets con asistente de severidad, relojes de plazos, pausas justificadas, escalamiento e informes mensuales. | <EstadoCapacidad id="mesa-soporte" /> |
| Correo de soporte | <Contacto tipo="soporte" /> | — |
| Reporte de vulnerabilidades | <Contacto tipo="seguridad" /> (ver [Seguridad](./seguridad.md#reporte-de-vulnerabilidades)) | — |

La recepción de solicitudes es 24x7 para todas las severidades.

## Niveles de servicio estándar del soporte Nexo {#niveles-de-servicio}

Plazos máximos contados desde la recepción de la solicitud:

| Severidad | Cuándo aplica | Acuse de recibo | Diagnóstico | Solución o solución temporal | Cobertura |
| --- | --- | --- | --- | --- | --- |
| **S1** | Servicio productivo caído y sin alternativa operativa. | 1 h | 2 h | **4 h corridas** | 24x7, todos los días del año |
| **S2** | Servicio productivo caído con alternativa operativa, degradación medible en producción o riesgo de seguridad activo. | 4 h | 8 h | 24 h corridas | 24x7, todos los días del año |
| **S3** | Falla en ambientes no productivos o en una funcionalidad no crítica. | 8 h hábiles | 3 días hábiles | 10 días hábiles | Recepción 24x7; plazos en horario hábil |
| **S4** | Consulta o solicitud de cambio, sin falla. | 1 día hábil | — | Según lo acordado | Recepción 24x7; plazos en horario hábil |

- Una **solución temporal** restablece el servicio mientras se prepara la solución definitiva, que se entrega como parche con su plan de reversa.
- El reloj de un plazo solo se pausa por causas tipificadas (por ejemplo, un acceso que debe habilitar la institución), con su justificación y visible para la institución.
- Después de cada incidente S1 o S2, Yago entrega un análisis de causa raíz.
- El horario hábil, los contactos y las ventanas de mantención de cada institución se fijan en su contrato.

## Severidades {#severidades}

La severidad no depende de una apreciación personal: se obtiene con preguntas cerradas, en este orden. La regla está implementada en `@nexo/shared` (función `classifySeverity`: <EstadoCapacidad id="nexo-shared" />) y la usará el asistente de la mesa de soporte (<EstadoCapacidad id="mesa-soporte" />).

1. ¿Es una consulta o una solicitud de cambio, sin falla? → **S4**.
2. ¿Hay APIs o integraciones productivas que no responden, o que fallan para todos sus consumidores, **sin** una alternativa operativa? → **S1**.
3. ¿Ocurre lo mismo, pero **existe** una alternativa operativa (otro nodo, otra ruta o un procedimiento manual)? → **S2**.
4. ¿Hay degradación medible en producción (latencia o errores sobre lo comprometido) o un riesgo de seguridad activo? → **S2**.
5. En otro caso (falla en ambientes no productivos, en una funcionalidad no crítica o sin impacto productivo) → **S3**.

Ejemplos:

<SeveridadEjemplos />
