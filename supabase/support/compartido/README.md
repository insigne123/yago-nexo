# Cambios en objetos de otra aplicación del proyecto compartido

El proyecto Supabase de la mesa de soporte es compartido con otra aplicación. Esa aplicación tiene en
`auth.users` el trigger `public.crear_persona()`, que **rechaza toda cuenta nueva** cuyo correo no esté
autorizado en ella. Sin un ajuste, la mesa Nexo no puede tener cuentas en este proyecto.

Con autorización de Yago (04-10-2026) se agregó una excepción mínima al inicio de esa función:

| Archivo | Qué hace |
|---|---|
| `../migrations/20261004140000_nexo_sd_cuentas_autorizadas.sql` | Crea `nexo_private.sd_cuentas_autorizadas`, la lista de correos de la mesa (solo el rol de servicio puede escribirla). |
| `excepcion_crear_persona.sql` | Reemplaza `public.crear_persona()` con la misma función más 6 líneas al inicio: si el correo está en esa lista, acepta la cuenta sin crear fila en `public.personas`. El resto de la función queda idéntico; se conservan el dueño y los permisos. |
| `revertir_crear_persona.sql` | La definición original exacta, tomada antes del cambio. Ejecutarla revierte la excepción. |

Verificado el 04-10-2026 con cuentas temporales (luego borradas): una cuenta autorizada se crea y no
aparece en `public.personas`; una no autorizada sigue rechazada como antes.

**Cuidado:** la otra aplicación sigue en desarrollo. Si una migración suya vuelve a definir
`crear_persona()`, la excepción desaparece y la mesa deja de poder crear cuentas. Quien mantenga esa
aplicación debe conservar el bloque de la excepción (o volver a aplicar `excepcion_crear_persona.sql`
sobre su nueva versión). Por eso conviene, a mediano plazo, mover la mesa a un proyecto propio.
