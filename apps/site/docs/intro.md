---
title: Introducción
description: Qué es Yago Nexo, qué existe en la versión actual y cómo leer esta documentación.
---

import LeyendaEstados from '@site/src/components/LeyendaEstados';
import ListaCapacidades from '@site/src/components/ListaCapacidades';
import ResumenEstados from '@site/src/components/ResumenEstados';
import VersionActual from '@site/src/components/VersionActual';

# Introducción

**Yago Nexo** es una plataforma de gestión de APIs e integración para instituciones públicas, desarrollada por Sociedad de Inversiones Yago SpA. Es una *distribución*: parte de componentes de código abierto reconocidos, los configura como un solo producto y les agrega una capa propia de Yago.

Versión actual: <VersionActual />.

## Qué resuelve

Las instituciones públicas publican servicios para otras instituciones, para empresas y para la ciudadanía, y además integran sistemas internos de distintas épocas. Nexo está pensado para que esas APIs e integraciones:

- se publiquen a partir de un contrato (OpenAPI) y con un ciclo de vida claro;
- se protejan con la identidad de la institución (Keycloak) y con políticas de seguridad y de uso;
- se puedan observar, auditar y operar con continuidad entre el centro de datos y la nube;
- queden gobernadas: quién es el dueño de cada API, quién la consume y de qué depende.

Nexo está diseñado para instalarse en la infraestructura de la institución. No es un servicio en la nube de terceros.

## Cómo se compone

| Parte | Qué incluye |
| --- | --- |
| Base abierta | WSO2 API Manager 4.7.0 (gateway, portales y ciclo de vida de APIs) y WSO2 Micro Integrator 4.6.0 (integración), ambos con licencia Apache 2.0, más Keycloak, PostgreSQL, RabbitMQ y herramientas de observabilidad de código abierto. |
| Capa Yago | Consola Nexo; motores de descubrimiento de APIs, detección de anomalías con bloqueo, despliegues progresivos con reversa automática y conmutación entre sitios con quórum; instaladores y pruebas de aceptación. |
| Servicio | Soporte con niveles de servicio definidos, capacitación por rol y esta documentación. |

WSO2 se menciona solo para identificar el origen de los componentes de la base; Yago Nexo no está afiliado a WSO2 LLC (ver [Licencia y avisos](./licencia-y-avisos.md)). El detalle de cada componente y su licencia está en [Componentes y licencias](./componentes-y-licencias.md).

## Qué existe hoy

La versión <VersionActual formato="numero" /> es la primera versión estable de Yago Nexo. Cada capacidad marcada como *Disponible* está implementada y verificada en el laboratorio de referencia, con la ruta del repositorio donde comprobarla. Los instaladores para producción (CPD y Google Cloud) todavía figuran *En desarrollo*. Está disponible lo siguiente:

<ListaCapacidades estado="Disponible" />

El resto de las capacidades figura como *En desarrollo* o *Planificado*; la [hoja de ruta](./hoja-de-ruta.md) las muestra todas. El contrato OpenAPI de la [API de la Consola](./api-consola.md) está publicado y corresponde a la API implementada.

<ResumenEstados />

## Cómo leer los estados

Cada capacidad de esta documentación lleva una insignia con su estado:

<LeyendaEstados />

Los estados provienen de un único archivo de datos del sitio, que se revisa en cada versión. Una capacidad solo puede marcarse como *Disponible* si indica dónde verificarla en el repositorio; si falta esa evidencia, el sitio no se genera.

## Mapa de la documentación

- [Arquitectura](./arquitectura.md): capas, ambientes y continuidad entre sitios (diseño).
- [Componentes y licencias](./componentes-y-licencias.md): software de terceros, versiones y licencias.
- [Laboratorio](./laboratorio.md): cómo levantar la base de Nexo en un equipo con Docker.
- [Seguridad](./seguridad.md): identidad, roles, auditoría, TLS, secretos y reporte de vulnerabilidades.
- [Ciclo de vida y soporte](./ciclo-de-vida-y-soporte.md): versiones, política de soporte y niveles de servicio.
- [Capacitación](./capacitacion/index.md): programa por rol, laboratorio por participante y certificación del fabricante.
- [API de la Consola](./api-consola.md): contrato OpenAPI y referencia por sección.
- [Hoja de ruta](./hoja-de-ruta.md): todas las capacidades con su estado.
- [Licencia y avisos](./licencia-y-avisos.md): licencia de Nexo, avisos de terceros y marcas.
