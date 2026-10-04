---
title: Componentes y licencias
description: Componentes de terceros de Yago Nexo, sus licencias y las versiones incluidas en el laboratorio; inventario CycloneDX por versión.
---

import Componentes from './_generated/componentes.md';
import SoloLaboratorio from './_generated/componentes-solo-laboratorio.md';
import EstadoCapacidad from '@site/src/components/EstadoCapacidad';
import VersionActual from '@site/src/components/VersionActual';
import { SiNoDisponible } from '@site/src/components/SegunEstado';

# Componentes y licencias

Nexo combina componentes de terceros de código abierto con código propio de Yago. Esta página resume qué componente cumple cada función, con qué licencia y si ya forma parte del laboratorio.

## Componentes de la plataforma

La columna *En el laboratorio* no se escribe a mano: se calcula al generar este sitio desde `deploy/compose` (la imagen de cada servicio o la imagen base de su Dockerfile). *No incluido todavía* indica un componente previsto en la [arquitectura](./arquitectura.md) que aún no se integra.

<Componentes />

## Usados solo en el laboratorio

Simulan una plataforma existente para probar el descubrimiento de APIs y la migración. No forman parte de Nexo.

<SoloLaboratorio />

## Herramientas de desarrollo

No se entregan ni se instalan en la institución.

| Herramienta | Uso | Licencia | En el repositorio |
| --- | --- | --- | --- |
| Gitleaks | Detección de secretos en el código | MIT | Sí, en el CI (`.github/workflows/ci.yml`) |
| Trivy | Vulnerabilidades, secretos y configuración | Apache 2.0 | Sí, en el CI; por ahora informativo (no detiene el CI) |
| Syft y Grype | SBOM y vulnerabilidades de cada versión | Apache 2.0 | Todavía no |
| Semgrep CE | Análisis estático de código | LGPL 2.1 | Todavía no |
| cosign | Firma de imágenes | Apache 2.0 | Todavía no |
| OWASP ZAP | Pruebas de seguridad dinámicas | Apache 2.0 | Todavía no |
| k6 | Pruebas de rendimiento | **AGPL 3.0** | Todavía no |
| Ansible | Aprovisionamiento de máquinas virtuales | GPL 3.0 | Todavía no |

## Componentes con licencia AGPL

- **Grafana (AGPL 3.0)** se usa sin modificaciones, desde su imagen oficial, y se declara en este inventario.
- **k6 (AGPL 3.0)** se usará solo como herramienta de pruebas de rendimiento; no forma parte de lo que se entrega.

Ningún componente con licencia AGPL se modifica ni se integra en el código propio de Yago.

## Inventario por versión (SBOM)

Estado: <EstadoCapacidad id="sbom" />

Cada versión de Nexo acompañará su inventario completo de componentes en formato **CycloneDX** (SBOM): nombre, versión exacta, licencia y origen de cada componente, junto con las sumas de verificación de los artefactos y la firma de las imágenes.

<SiNoDisponible id="sbom">

La versión actual (<VersionActual formato="numero" />) todavía no incluye SBOM, porque la herramienta que lo genera en cada versión está en desarrollo. Mientras tanto, la referencia es esta página junto con el archivo `NOTICE` del repositorio (ver [Licencia y avisos](./licencia-y-avisos.md)).

</SiNoDisponible>
