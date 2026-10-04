---
title: Hoja de ruta
description: Todas las capacidades de Yago Nexo agrupadas por área, con su estado actual (Disponible, En desarrollo o Planificado) y la evidencia en el repositorio de las disponibles.
---

import LeyendaEstados from '@site/src/components/LeyendaEstados';
import ResumenEstados from '@site/src/components/ResumenEstados';
import TablaCapacidades from '@site/src/components/TablaCapacidades';
import VersionActual from '@site/src/components/VersionActual';

# Hoja de ruta

La hoja de ruta de Nexo se organiza **por capacidad**, no por fecha. Cada capacidad muestra su estado en la versión <VersionActual /> y, si está disponible, dónde verificarla en el repositorio.

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

## Cómo se mantiene esta hoja de ruta

- El estado de cada capacidad está en un único archivo de datos del sitio (`apps/site/src/data/capacidades.json`), que alimenta esta página, la portada y las insignias del resto de la documentación.
- Una capacidad pasa a *Disponible* solo cuando existe en el repositorio de la versión publicada; el sitio no se genera si una capacidad disponible no indica su evidencia o si esa evidencia no existe.
- Los cambios de estado se anuncian en [Novedades](/novedades) con cada versión.
