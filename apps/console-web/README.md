# Consola Nexo (web)

Interfaz de la Consola Nexo: catálogo con ficha de gobierno, dependencias e impacto, descubrimiento (D-01), anomalías (D-02), despliegues progresivos (D-04), continuidad (D-05), consumo (BT-021), mensajes fallidos (BT-051), auditoría (BT-031/032), cumplimiento y exportación.

El mismo build sirve para la demo (Firebase Hosting) y para los servidores de la institución (contenedor NGINX): lo que cambia por ambiente se lee al iniciar desde `/config.json`.

Tecnología: Vite 8, React 19, TypeScript 5.9, Tailwind CSS 4, React Router 7, TanStack Query 5, React Flow 12, ECharts 6, oidc-client-ts 3, supabase-js 2 y MSW 2. El cliente de la API se genera desde el contrato `apps/console-api/openapi.yaml`.

## Comandos

Desde la raíz del monorepo, después de `pnpm install`:

| Comando | Qué hace |
|---|---|
| `pnpm --filter @nexo/console-web dev` | Servidor de desarrollo en http://localhost:5173 |
| `pnpm --filter @nexo/console-web build` | Verifica tipos y genera `dist/` |
| `pnpm --filter @nexo/console-web preview` | Sirve `dist/` en http://localhost:4173 |
| `pnpm --filter @nexo/console-web test` | Pruebas (Vitest, Testing Library, jsdom y MSW) |
| `pnpm --filter @nexo/console-web lint` | ESLint (reglas del monorepo más React Hooks) |
| `pnpm --filter @nexo/console-web typecheck` | TypeScript sin emitir archivos |
| `pnpm --filter @nexo/console-web gen:api` | Regenera `src/api/schema.d.ts` desde el OpenAPI |

## Configuración (`/config.json`)

```json
{
  "apiBaseUrl": "/api/v1",
  "environmentLabel": "Laboratorio Yago",
  "auth": {
    "provider": "mock",
    "oidc": { "authority": "http://keycloak:8080/realms/nexo", "clientId": "nexo-console", "rolesClaimPath": "resource_access.nexo-console.roles" },
    "supabase": { "url": "https://xxx.supabase.co", "anonKey": "...", "requireMfa": true }
  },
  "demoBanner": true
}
```

- `version` es opcional: sin ella se muestra la versión del build, que sale de `package.json` (la demo publicada no la fija). En Kubernetes la escribe el chart con su `appVersion`.
- `auth.provider`: `mock`, `oidc` o `supabase`. Solo se valida el bloque del proveedor elegido; si falta un dato, la Consola muestra qué campo corregir.
- `demoBanner`: franja superior con «ambiente · Nexo versión · fecha y hora local» que se actualiza cada segundo. La usan los videos de Playwright como prueba de fecha y versión.
- Valores opcionales: `oidc.scope` (por defecto `openid profile email`), `supabase.rolesClaimPath` (por defecto `app_metadata.roles`) y `supabase.requireMfa` (por defecto `true`).
- Los roles y permisos que muestra la interfaz vienen de `GET /me`. Si esa llamada falla, se calculan desde los roles del token con la matriz de `@nexo/shared`. La API vuelve a validar cada acción: la interfaz solo lo refleja.

## Modo simulado (sin backend)

Con `"provider": "mock"` (el `public/config.json` de desarrollo) la Consola arranca Mock Service Worker y responde todas las rutas del contrato desde un almacén en memoria con datos sintéticos (RUT y empresas de `SyntheticData`, APIs de concesiones, PISEE, reclamos, espectro y portabilidad, tres sitios CPD, GCP y testigo).

```bash
pnpm --filter @nexo/console-web dev
# abrir http://localhost:5173 y elegir un usuario
```

- Hay un usuario por rol (los mismos del realm del laboratorio) y un caso de prueba con dos roles, `marta.dosroles`, para comprobar la regla de cuatro ojos: puede crear un despliegue pero no aprobarlo.
- Las acciones cambian el estado y quedan en la auditoría encadenada: aprobar un bloqueo, liberar, clasificar hallazgos, reprocesar mensajes, exportar, etc. Como en la API, un 403 queda como `acceso.rechazado.permiso` o `acceso.rechazado.cuatro_ojos`, y una escritura que no se completa queda con resultado «rechazado».
- El análisis de impacto usa el mismo motor que la API (`impactOf` de `apps/console-api/src/modules/catalog-graph.ts`, importado como `@nexo/console-api/impacto`) y la exportación arma la misma lista de archivos.
- El tiempo de los procesos va acelerado diez veces: un paso de despliegue de 60 s dura 6 s (entre 4 y 15 s). Un endpoint candidato que contenga `mala` o `falla` simula una versión defectuosa y se revierte solo en el primer paso.
- El simulacro de conmutación hace lo mismo que el agente de continuidad: mide la réplica y confirma que es promovible, sin conmutar. En Continuidad, «Herramientas del modo simulado» provoca la caída del sitio principal: con el modo automático, los agentes conmutan a GCP con los pasos del agente y registran el RTO. Después, una persona solicita el retorno (`continuity:failback:request`, motivo obligatorio, vence a los 30 minutos) y otra lo aprueba; el paso «Re-sincronizar la réplica» queda pendiente para el operador.
- En Auditoría aparece «Herramientas del modo simulado» para alterar un evento y demostrar que la verificación de la cadena lo detecta.
- El estado se guarda en la pestaña (sessionStorage): sobrevive a recargas y a cambios de usuario. «Restablecer datos de demostración», en la pantalla de ingreso, vuelve al estado inicial.
- Con otro proveedor se puede forzar el modo simulado abriendo la Consola con `?mock=1` (se recuerda en la pestaña; `?mock=0` lo apaga). Así se usa, por ejemplo, el ingreso real de Keycloak con datos simulados.
- Los service workers requieren HTTPS o `localhost`. Todo lo que se ve en este modo está marcado como «Datos simulados».

## Modo OIDC con el Keycloak del laboratorio

1. Levante el laboratorio (`pnpm lab:up`). Keycloak publica `http://keycloak:8080`, así que agregue `127.0.0.1 keycloak` a `/etc/hosts` para que el navegador y los tokens usen el mismo emisor.
2. Use este `public/config.json`:

   ```json
   {
     "apiBaseUrl": "/api/v1",
     "environmentLabel": "Laboratorio Yago",
        "auth": {
       "provider": "oidc",
       "oidc": { "authority": "http://keycloak:8080/realms/nexo", "clientId": "nexo-console", "rolesClaimPath": "resource_access.nexo-console.roles" }
     },
     "demoBanner": true
   }
   ```

3. `pnpm --filter @nexo/console-web dev` y abra http://localhost:5173 (es una de las URL de retorno permitidas del cliente `nexo-console`, junto con `http://localhost:8090/*`).
4. Ingrese con un usuario del realm `nexo`, por ejemplo `luis.aprobador`, `ana.desarrollo`, `carla.operacion`, `pedro.auditoria`, `admin.nexo` o `consumidor.demo`; todos con la clave `Nexo-Lab-2026!`.

El flujo es Authorization Code con PKCE (oidc-client-ts), con renovación silenciosa (refresh token o, si no hay, el iframe `/auth/silent-callback`) y cierre de sesión también en Keycloak. Los roles se leen del access token en `resource_access.nexo-console.roles`.

En desarrollo, las llamadas a `/api` se envían a la API de la Consola en `http://localhost:3000` (cámbielo con `NEXO_API_URL`). Si la API aún no está disponible, abra http://localhost:5173/?mock=1.

## Modo Supabase (demo publicada)

```json
{
  "apiBaseUrl": "https://api-demo.nexo.example/api/v1",
  "environmentLabel": "Demo Yago",
  "auth": {
    "provider": "supabase",
    "supabase": { "url": "https://<proyecto>.supabase.co", "anonKey": "<clave pública anon>", "requireMfa": true }
  },
  "demoBanner": true
}
```

- Ingreso con correo y contraseña. Si el usuario tiene un factor TOTP verificado, se pide el código de 6 dígitos (nivel aal2). Si el proyecto exige MFA (`requireMfa`) y el usuario no tiene factor, se muestra el enrolamiento con código QR y clave manual.
- Los roles se leen de `app_metadata.roles` del token. Se asignan desde el backend, por ejemplo: `update auth.users set raw_app_meta_data = raw_app_meta_data || '{"roles":["aprobador"]}' where email = 'persona@ejemplo.invalid';`
- La `anonKey` es la clave pública del proyecto; nunca use la `service_role` en la Consola.

## Contenedor NGINX (producción)

```bash
pnpm --filter @nexo/console-web build
cd apps/console-web
docker build -t nexo/console-web:1.2.0 .
docker run -p 8090:8080 \
  -v "$PWD/config.produccion.json:/etc/nexo/config.json:ro" \
  -e NEXO_CSP_CONNECT_SRC="'self' https://sso.institucion.example https://api-consola.institucion.example" \
  -e NEXO_CSP_FRAME_SRC="'self' https://sso.institucion.example" \
  nexo/console-web:1.2.0
```

- `nginx.conf` sirve la aplicación con respaldo a `index.html`, gzip, caché larga para `/assets/`, `/healthz` para las sondas y encabezados de seguridad (CSP sin `unsafe-inline` ni `unsafe-eval` para scripts, HSTS, `nosniff`, `frame-ancestors 'self'`, Permissions-Policy).
- `/config.json` se lee desde `/etc/nexo/config.json` (monte ahí un ConfigMap) y nunca queda en caché.
- La CSP permite conexiones solo a los orígenes de `NEXO_CSP_CONNECT_SRC`: agregue la API de la Consola, el Keycloak o el proyecto de Supabase del ambiente.

En Firebase Hosting se publica la misma carpeta `dist/` con reescritura de todas las rutas a `/index.html`, `Cache-Control: no-store` para `/config.json` y la misma política de seguridad de contenido, con `connect-src 'self'` y `frame-ancestors 'none'` (`firebase.json`; lo prueba `src/config/hosting.test.ts`).

## Para los guiones de Playwright

- Los controles principales tienen `data-testid`: navegación (`nav-catalogo`, `nav-despliegues`…), ingreso simulado (`mock-login-aprobador`, `mock-login-marta.dosroles`), botones (`btn-sync-wso2`, `btn-approve-rollout`, `btn-abort-rollout`, `btn-start-drill`, `btn-request-failback`, `btn-approve-failback`, `btn-reject-failback`, `btn-mock-outage`, `btn-verify-audit`, `btn-create-export`, `btn-logout`…), tablas (`table-apis`, `table-findings`, `table-audit`…), estados (`rollout-status`, `anomaly-status-<id>`, `finding-status-<id>`) y el banner (`demo-banner-text`).
- Una acción sin permiso no se oculta: queda deshabilitada (`aria-disabled="true"`, `data-blocked="permiso"` o `"regla"`) con un tooltip que nombra el permiso que falta.
- Para un estado inicial conocido, use «Restablecer datos de demostración» (`btn-mock-reset`) en la pantalla de ingreso.

## Estructura

```
src/
  api/          cliente openapi-fetch, tipos generados, consultas y mutaciones
  auth/         proveedores mock, oidc y supabase; sesión y permisos; pantallas de ingreso
  components/   primitivas de interfaz (ui/), estructura (layout/), gráficos (charts/)
  config/       carga y validación de /config.json
  features/     piezas de dominio reutilizables (grafo, impacto, auditoría, catálogo)
  mocks/        backend simulado para MSW (almacén, datos semilla, manejadores)
  pages/        una carpeta por pantalla (se cargan bajo demanda)
```
