---
title: API de la Consola
description: Contrato OpenAPI 3.1 de la API de la Consola Nexo, convenciones de autenticación, autorización y auditoría, y referencia por sección.
---

import Indice from './_generated/api-indice.md';
import EstadoCapacidad from '@site/src/components/EstadoCapacidad';
import { SiNoDisponible } from '@site/src/components/SegunEstado';

# API de la Consola

Estado de la implementación: <EstadoCapacidad id="consola" />

La Consola Nexo tendrá una API REST propia, que usará su interfaz web y que podrán usar otras herramientas de la institución. Su contrato está escrito en **OpenAPI 3.1** y se publica desde ya, para que los equipos técnicos lo revisen antes de su implementación.

<SiNoDisponible id="consola">

:::note Contrato de diseño

La API todavía no está implementada. Esta referencia describe la interfaz prevista y puede cambiar mientras se construye; los cambios se informarán en [Novedades](/novedades).

:::

</SiNoDisponible>

## Descargar el contrato

[`openapi.yaml`](pathname:///openapi.yaml): copia pública del contrato del repositorio (`apps/console-api/openapi.yaml`), con las mismas rutas y esquemas; solo se omiten referencias internas de trazabilidad. Sirve para generar clientes o importarlo en herramientas compatibles con OpenAPI.

## Convenciones

- **Ruta base:** `/api/v1`.
- **Autenticación:** todas las rutas exigen `Authorization: Bearer <JWT>`, emitido por el Keycloak de la institución. Los roles del usuario vienen en el token.
- **Autorización:** cada operación exige un permiso de la [matriz rol-permiso](./seguridad.md#matriz-rol-permiso). Sin el permiso, la API responde `403` con un cuerpo [`Error`](/docs/referencia-api/esquemas#esquema-error).
- **Cuatro ojos:** en las aprobaciones (bloqueos, despliegues a producción, reproceso de mensajes y retorno al sitio principal), quien aprueba debe ser distinto de quien inició la acción.
- **Auditoría:** toda acción de escritura genera un [evento de auditoría encadenado](./seguridad.md#auditoria).
- **Formatos:** JSON; algunas exportaciones también en CSV (consumo y reporte de descubrimiento).
- **Errores:** `403` sin permiso y `404` recurso inexistente, ambos con el esquema `Error` (`statusCode`, `message` y, cuando corresponde, `permission`).

## Secciones

La referencia se genera desde el contrato cada vez que se construye este sitio:

<Indice />
