---
title: Capacitación
sidebar_label: Programa y rutas
description: Programa de capacitación de Yago Nexo (40 horas en 8 sesiones), rutas por rol, laboratorio por participante, evaluación y certificación del fabricante.
---

import EstadoCapacidad from '@site/src/components/EstadoCapacidad';
import { SiNoDisponible } from '@site/src/components/SegunEstado';

# Capacitación

Programa de capacitación de Yago Nexo para los equipos que administran, desarrollan, integran y protegen la plataforma. Es **práctico**: cada módulo tiene ejercicios que cada participante hace en **su propio laboratorio**, una copia completa del laboratorio Docker Compose de Nexo.

- **40 horas sincrónicas**, en **8 sesiones de 5 horas**.
- **Rutas por rol**: cada persona cursa los módulos de su ruta; la ruta de certificación cubre todos.
- **Un laboratorio por participante**: nadie comparte su ambiente de práctica (ver [Laboratorio del participante](./laboratorio-participante.md)).
- **Certificación del fabricante**: Yago, como fabricante de la distribución, certifica a quienes aprueban el examen teórico y la evaluación práctica (ver [Certificación](./certificacion.md)).

Portal de capacitación: <EstadoCapacidad id="portal-capacitacion" />

<SiNoDisponible id="portal-capacitacion">

:::note Qué existe hoy

Esta sección reúne el programa, las guías de cada módulo y los ejercicios. El portal con cursos por rol y verificación automática de cada ejercicio por participante está en desarrollo. Mientras tanto, los ejercicios se comprueban con los scripts de verificación que trae el laboratorio (`pnpm --filter @nexo/lab-bootstrap check:…`) y con las autoevaluaciones de cada módulo.

:::

</SiNoDisponible>

## Programa {#programa}

| Módulo | Horas | Contenido |
| --- | :-: | --- |
| [M0 · Inducción, arquitectura y laboratorio](./m0-induccion.md) | 4 | Qué es Nexo, sus capas y estados; levantar y recorrer el laboratorio propio. |
| [M1 · Instalación, despliegue y actualización](./m1-instalacion.md) | 6 (1 + 5) | Preparar el laboratorio, plataforma como código, despliegue de APIs por etapas, verificación de una versión, actualización y restablecimiento. |
| [M2 · Administración de la plataforma](./m2-administracion.md) | 5 | Flujos de aprobación, planes de uso, ambientes de gateway, identidad, roles de la Consola y estado de los motores. |
| [M3 · Diseño, publicación y ciclo de vida de APIs](./m3-apis.md) | 5 | Contratos y guía de estilo, promoción y reversa, catálogo e impacto, APIs GraphQL y de eventos, SDK y despliegues progresivos. |
| [M4 · Integración con Micro Integrator](./m4-integracion.md) | 5 | Flujo de solicitudes: validación, idempotencia, SOAP, colas, reintentos, mensajes fallidos y reproceso. |
| [M5 · Seguridad e identidad](./m5-seguridad.md) | 5 | Tokens y TLS, auditoría encadenada, guardián de anomalías, descubrimiento de APIs no gobernadas y audiencias. |
| [M6 · Observabilidad, continuidad, soporte e incidentes](./m6-operacion.md) | 5 | Métricas, tableros, alertas, trazas, SIEM, conmutación entre sitios, severidades y mesa de soporte. |
| [M7 · Repaso, evaluación práctica y examen de certificación](./m7-evaluacion.md) | 5 | Repaso, examen teórico de 40 preguntas y evaluación práctica en el laboratorio. |
| **Total** | **40** | |

### Calendario por sesión {#calendario}

| Sesión | Módulos | Horas |
| :-: | --- | :-: |
| 1 | M0 (4 h) y primera parte de M1 (1 h) | 5 |
| 2 | Segunda parte de M1 | 5 |
| 3 | M2 | 5 |
| 4 | M3 | 5 |
| 5 | M4 | 5 |
| 6 | M5 | 5 |
| 7 | M6 | 5 |
| 8 | M7 | 5 |

Las pausas de cada sesión están indicadas en la agenda de cada módulo.

## Rutas por rol {#rutas}

Cada ruta tiene módulos obligatorios. M0 y M7 están en todas: M0 entrega la base común y el laboratorio; M7 cierra con repaso y evaluación.

| Ruta | M0 | M1 | M2 | M3 | M4 | M5 | M6 | M7 | Horas |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Administración | ✓ | ✓ | ✓ | | | | ✓ | ✓ | 25 |
| Desarrollo/APIs | ✓ | | ✓ | ✓ | | ✓ | | ✓ | 24 |
| Integración | ✓ | | | ✓ | ✓ | | ✓ | ✓ | 24 |
| Seguridad | ✓ | | ✓ | | | ✓ | ✓ | ✓ | 24 |
| Certificación | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 40 |

- **Administración**: quienes instalan, actualizan y operan la plataforma.
- **Desarrollo/APIs**: quienes diseñan, publican y mantienen APIs.
- **Integración**: quienes construyen y operan flujos entre sistemas.
- **Seguridad**: quienes gobiernan identidad, accesos, auditoría y exposición.
- **Certificación**: quienes buscan la certificación de Administrador/Integrador de la plataforma.

Quien sigue una ruta que no incluye M1 recibe el laboratorio ya preparado al terminar M0 (ver [Laboratorio del participante](./laboratorio-participante.md#preparacion)). En M7, las rutas por rol hacen el repaso y los ejercicios de su ruta; el examen teórico y la evaluación práctica son de la ruta de certificación.

## Cómo funcionan los laboratorios {#laboratorios}

- Cada participante recibe **su propia copia** del laboratorio de Nexo (`deploy/compose`), en un equipo o máquina virtual dedicados: el laboratorio usa nombres y puertos fijos, así que en un mismo equipo cabe un solo laboratorio.
- Se prepara una sola vez, en M0 y M1, y se reutiliza en todo el curso. Al inicio de M7 se restablece desde cero para la evaluación.
- Cada ejercicio indica sus requisitos (por ejemplo, el perfil `obs` o el laboratorio de continuidad) y cómo comprobar el resultado.
- Los ejercicios usan los comandos reales del laboratorio: `make -C deploy/compose …`, `nexo-ctl`, las REST API de WSO2, la API de la Consola y los scripts de verificación de `tools/lab-bootstrap`.
- Las capacidades en estado *Disponible* se practican en el laboratorio. Las que están *En desarrollo* se explican en secciones marcadas como tales, sin ejercicios.

## Estructura de cada módulo {#estructura}

1. **Objetivos de aprendizaje**: lo que el participante sabrá hacer al terminar.
2. **Agenda**: bloques de tiempo de la sesión.
3. **Conceptos**: lo justo para entender los ejercicios.
4. **Ejercicios de laboratorio**: objetivo, pasos con comandos reales, resultado esperado y autoevaluación.

## Evaluación y certificación {#evaluacion}

| Qué | Cómo | Cuándo |
| --- | --- | --- |
| Avance por módulo | Autoevaluación al final de cada ejercicio y verificación de los resultados en el laboratorio. No lleva nota. | En cada sesión |
| Examen teórico | 40 preguntas de selección única, sorteadas de un banco y equilibradas entre M0 y M6. 60 minutos. | Sesión 8 (M7) |
| Evaluación práctica | 5 tareas en el laboratorio propio, verificadas con los scripts del laboratorio y con la evidencia de la terminal. 150 minutos. | Sesión 8 (M7) |

**Para certificarse** hay que cursar la ruta de certificación, obtener **al menos 70 %** en el examen teórico **y** aprobar la evaluación práctica. Las reglas completas, la vigencia y la verificación de certificados están en [Certificación](./certificacion.md).

**Asistencia.** Para rendir la evaluación se exige asistir al menos al 80 % de las horas de la ruta. Las rutas por rol reciben una constancia de participación; la certificación es solo para la ruta completa.

## Convenciones de los ejercicios {#convenciones}

- Los comandos se ejecutan desde la **raíz del repositorio**, salvo que el paso indique otra carpeta.
- Las ayudas del curso abrevian llamadas que se repiten (tokens, API de la Consola, `nexo-ctl`). Se cargan una vez por terminal:

  ```bash
  source tools/lab-bootstrap/ayudas-curso.sh
  ```

  Quedan disponibles `tok`, `consola`, `consola_estado`, `app_llaves`, `app_tok`, `nexo-ctl`, `mi_api` y `caos`. El detalle está en [Laboratorio del participante](./laboratorio-participante.md#ayudas).
- Todas las credenciales son de laboratorio y salen de `deploy/compose/.env`. Nunca se usan datos reales: los backends de ejemplo entregan datos sintéticos.
