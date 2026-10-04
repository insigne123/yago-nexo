# Mesa de soporte Nexo · Aplicación web (`@nexo/support-web`)

Interfaz de la mesa de soporte 24x7: SUBTEL abre y sigue sus tickets y Yago los atiende con relojes SLA en vivo. Usa Vite 8, React 19, TypeScript 5.9.3, Tailwind CSS 4, React Router 7, TanStack Query 5, `@supabase/supabase-js` 2 y zod. La base de datos, las reglas de acceso y las funciones están en `supabase/support/`.

## Pantallas

| Perfil | Pantallas |
|---|---|
| Reportante y contraparte (SUBTEL) | **Nuevo ticket** con el asistente de severidad (preguntas de sí o no con ayuda y ejemplos de la matriz; muestra la severidad, la regla y los plazos antes de enviar) · **Mis tickets** con los relojes de acuse, diagnóstico y solución en vivo (tiempo restante, pausa, vencido en rojo) · **Ficha del ticket** con línea de tiempo pública, comentarios, adjuntos, acuse u objeción de pausas y aprobación de accesos remotos (contraparte) · **Informes mensuales** (descarga del PDF) · **Documentos** (RCA y paquetes de corrección; la contraparte los aprueba) |
| Agente y supervisor (Yago) | **Bandeja** de todas las organizaciones, ordenable por vencimiento y filtrable por severidad, estado y organización, con aviso de cuarentena · **Ficha de trabajo** (cambiar estado, asignar, pausar y reanudar con motivo tipificado y justificación, notas internas, escalar, reclasificar, acceso remoto, marcar incidente de seguridad, aceptar o descartar la cuarentena) · **Turnos** (calendario semanal por nivel; crear, editar y eliminar) · **Incidentes de seguridad** con los hitos de la Ley 21.663 y sus cuentas regresivas · **Paquetes de corrección** con plan de reversa y aprobación de cuatro ojos · **Informes mensuales** (generación) · **Documentos** (RCA) |

Ingreso: correo y contraseña, y luego MFA TOTP **obligatorio**. El primer ingreso enrola la aplicación de autenticación (código QR y clave); los siguientes piden el código. Sin `aal2`, la base de datos no entrega datos, aunque se intente fuera de la interfaz. Las listas se actualizan solas con Supabase Realtime.

La interfaz oculta lo que cada perfil no puede hacer, pero quien decide es la base de datos (RLS y RPC).

## Desarrollo

```bash
pnpm install
pnpm --filter @nexo/support-web dev         # http://localhost:5174
pnpm --filter @nexo/support-web lint
pnpm --filter @nexo/support-web typecheck
pnpm --filter @nexo/support-web test        # Vitest + Testing Library (jsdom)
pnpm --filter @nexo/support-web build       # genera dist/
```

`@nexo/shared/browser` (la clasificación de severidad) se resuelve al código fuente de `packages/shared`, así que no hace falta compilarlo antes.

## Configuración en tiempo de ejecución

La aplicación lee `/config.json` al iniciar, así que el mismo build sirve para cualquier ambiente:

```json
{
  "supabaseUrl": "https://<ref>.supabase.co",
  "supabaseAnonKey": "<clave publicable (anon) del proyecto>",
  "environmentLabel": "producción"
}
```

- `supabaseAnonKey` es la clave **publicable**: nunca la clave de servicio. La seguridad la dan la RLS y el MFA.
- `environmentLabel` aparece en la cabecera (por ejemplo «demo» o «producción»).
- `public/config.json` trae valores de ejemplo para desarrollo. Con esos valores la aplicación muestra «no está configurada». Vite lo copia a `dist/`, y en cada despliegue se reemplaza `dist/config.json` por el del ambiente.

## Despliegue en Firebase Hosting (sitio `yago-nexo-soporte`)

No hay Dockerfile: se publica como sitio estático en Firebase Hosting, en el sitio **`yago-nexo-soporte`** (dominio previsto `soporte.yago.cl`). El `firebase.json` vive en la raíz del repositorio (no en esta carpeta). La entrada sugerida para este sitio es:

```json
{
  "hosting": [
    {
      "target": "soporte",
      "public": "apps/support-web/dist",
      "ignore": ["**/.*"],
      "rewrites": [{ "source": "**", "destination": "/index.html" }],
      "headers": [
        { "source": "/config.json", "headers": [{ "key": "Cache-Control", "value": "no-store" }] },
        { "source": "/index.html", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] },
        { "source": "/assets/**", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] },
        {
          "source": "**",
          "headers": [
            { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
            { "key": "X-Content-Type-Options", "value": "nosniff" },
            { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
            { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" }
          ]
        }
      ]
    }
  ]
}
```

Pasos (con el token o la cuenta de servicio de Firebase del CI):

```bash
pnpm --filter @nexo/support-web build
# config.json del ambiente (desde secretos del CI, nunca versionado con valores reales):
printf '{"supabaseUrl":"%s","supabaseAnonKey":"%s","environmentLabel":"%s"}\n' \
  "$SUPABASE_URL" "$SUPABASE_PUBLISHABLE_KEY" "producción" > apps/support-web/dist/config.json
firebase target:apply hosting soporte yago-nexo-soporte   # una vez
firebase deploy --only hosting:soporte
```

Esta entrega no necesita cambiar ajustes de Supabase Auth. Si más adelante se habilita la recuperación de contraseña por correo, habría que agregar `https://soporte.yago.cl` a las URL de redirección de Auth: es un ajuste del proyecto compartido y se coordina con el equipo de ANTON.IA. Si la función `nexo-sd-monthly-report` restringe CORS (`NEXO_ALLOWED_ORIGINS`), debe incluir ese origen.

## Pruebas

- `src/lib/severity.test.ts`: `classifySeverity` coincide con la matriz de 32 combinaciones que también verifica la prueba SQL de `nexo_private.sd_classify`, y el asistente progresivo llega siempre a la misma severidad.
- `src/features/wizard/SeverityWizard.test.tsx`: del asistente a la clasificación (S1, S3 y S4), con la regla y los plazos.
- `src/lib/sla.test.ts` y `src/components/SlaClock.test.tsx`: formato de la cuenta regresiva, estado en pausa (tiempo congelado) y vencido en rojo.
- `src/features/tickets/permissions-ui.test.tsx` y `src/lib/permissions.test.ts`: lo que ve el reportante, la contraparte y el agente.
- `src/config/runtime-config.test.ts` y `src/lib/queue.test.ts`: validación de `/config.json` y orden de la bandeja.

## Accesibilidad

Etiquetas visibles asociadas a cada campo, ayudas y errores enlazados con `aria-describedby`, grupos de preguntas con `fieldset` y `legend`, foco visible, enlace «Saltar al contenido», relojes con descripción completa para lectores de pantalla, colores con contraste suficiente y respeto de `prefers-reduced-motion`.
