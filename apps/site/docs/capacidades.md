---
title: Capacidades de la versión
description: Todas las capacidades de Yago Nexo agrupadas por área, con lo que incluye la versión publicada (y su evidencia en el repositorio) y lo que se entrega con el servicio de implementación.
---

import LeyendaEstados from '@site/src/components/LeyendaEstados';
import ResumenEstados from '@site/src/components/ResumenEstados';
import TablaCapacidades from '@site/src/components/TablaCapacidades';
import VersionActual from '@site/src/components/VersionActual';

# Capacidades de la versión

Esta página lista las capacidades de Yago Nexo en la versión <VersionActual />. Cada una dice con exactitud si está **incluida en la versión** (y dónde verificarla en el repositorio) o si **se entrega con el servicio de implementación**: en ese caso es desarrollo contratado que Yago entrega con su prueba de aceptación, y no se presenta como parte de la versión.

<LeyendaEstados />

<ResumenEstados />

## Base de la plataforma

<TablaCapacidades grupo="base" detalle descripcion />

## Gestión de APIs e integración

<TablaCapacidades grupo="nucleo" detalle descripcion />

## Capa Yago: Consola Nexo y motores

<TablaCapacidades grupo="capa-yago" detalle descripcion />

## Instalación y operación

<TablaCapacidades grupo="operacion" detalle descripcion />

## Servicio

<TablaCapacidades grupo="servicio" detalle descripcion />

## Cómo se mantiene esta página

- El estado de cada capacidad está en un único archivo de datos del sitio (`apps/site/src/data/capacidades.json`), que alimenta esta página, la portada y las insignias del resto de la documentación.
- Una capacidad figura como incluida solo cuando existe en el repositorio de la versión publicada; el sitio no se genera si una capacidad incluida no indica su evidencia o si esa evidencia no existe.
- En las capacidades que se entregan con el servicio de implementación, la columna de evidencia muestra la base que ya está en el repositorio, si la hay.
- Los cambios se anuncian en [Novedades](/novedades) con cada versión.
