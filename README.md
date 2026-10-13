# Yago Nexo

Plataforma de gestión de APIs e integración de **Sociedad de Inversiones Yago SpA**. Es una distribución de
Yago sobre WSO2 API Manager y WSO2 Micro Integrator (código abierto, Apache 2.0) más la capa propia de Yago:
la Consola Nexo (web y API), los motores de descubrimiento de APIs no gobernadas, anomalías, despliegues
progresivos y continuidad entre sitios, los instaladores, los pipelines de APIs y las pruebas de aceptación.

Sitio y documentación: <https://yago-nexo.web.app> · Licencia: [LICENSE](LICENSE) (código propio de Yago) y
[NOTICE](NOTICE) (componentes de terceros).

## Versiones

| Componente | Versión |
| --- | --- |
| Yago Nexo (este repositorio, imágenes `nexo-console-api`, `nexo-console-web` y `nexo-motores`, chart) | 1.2.0 |
| WSO2 API Manager: Control Plane, Traffic Manager y Universal Gateway | 4.7.0 |
| WSO2 Micro Integrator | 4.6.0 |
| Kubernetes en el centro de datos: RKE2 | v1.36.5+rke2r1 |
| Kubernetes en Google Cloud: GKE (canal de versiones de GKE) | según el canal |
| PostgreSQL | 16 |
| Keycloak (laboratorio; en producción, el de la institución) | 26.8 |
| Helm (instalador) | 4.3.0 |
| Node.js / pnpm (desarrollo) | 22 o superior / 10.28.0 |

Las versiones de todos los componentes están en el SBOM de cada versión publicada.

## Qué hay en el repositorio

| Carpeta | Contenido |
| --- | --- |
| `apps/` | Consola Nexo: `console-api` (NestJS) y `console-web` (React); `support-web` (mesa de soporte); `site` (sitio y documentación). |
| `services/` | `engines` (motores y agente de continuidad) y `demo-backends` (backends de ejemplo del laboratorio). |
| `packages/` | Bibliotecas compartidas: `shared`, `console-db` y `wso2-client`. |
| `tools/` | `nexo-ctl` (CLI de los pipelines de APIs), `respaldo`, `aceptacion`, `lab-bootstrap`, `evidencias`, `certificacion` y `release` (SBOM, vulnerabilidades, VEX y verificación de versiones). |
| `wso2/` | Artefactos de API Manager (APIs y plataforma como código) y de Micro Integrator. |
| `deploy/` | `helm/nexo-platform` (chart), `ansible/rke2` (CPD sobre vSphere), `opentofu/gcp-dr` (sitio de respaldo en Google Cloud) y `compose` (laboratorio). |
| `supabase/` | Base de la mesa de soporte (migraciones y pruebas). |
| `release/` | Archivos de cada versión, informe de rendimiento y el caso [LAB-PA-055-01](release/LAB-PA-055-01.md). |

## Instalación

En Kubernetes, con el chart `deploy/helm/nexo-platform` (guía completa: <https://yago-nexo.web.app/docs/instalacion>):

- **Centro de datos (RKE2 sobre VMware vSphere):** el playbook `deploy/ansible/rke2` prepara los nodos, instala
  RKE2 v1.36.5+rke2r1 (con el perfil CIS en el inventario de ejemplo) y Helm 4.3.0, crea los Secrets desde
  Ansible Vault e instala el chart con `values-cpd.yaml` (`helm upgrade --install`).
- **Sitio de respaldo en Google Cloud (GKE):** el módulo `deploy/opentofu/gcp-dr` crea la red, el clúster, el
  registro y el DNS; el chart se instala con `values-gcp-dr.yaml`.
- Los valores no llevan contraseñas: el chart lee Secrets creados antes de instalar (`secretos` en
  `values.yaml`). Todos los contenedores corren sin root y con la raíz de solo lectura.

Para validar los instaladores sin clúster ni nube (Helm lint, kubeconform, reglas de seguridad del chart, Ansible y
OpenTofu):

```bash
deploy/validar-instaladores.sh --instalar
```

## Laboratorio

Un equipo con Docker Compose levanta WSO2 API Manager, Micro Integrator, Keycloak, PostgreSQL, RabbitMQ, la
Consola, los motores y backends de ejemplo con datos sintéticos (guía: <https://yago-nexo.web.app/docs/laboratorio>):

```bash
pnpm install
pnpm --filter @nexo/shared --filter @nexo/wso2-client build
cp deploy/compose/.env.example deploy/compose/.env
make -C deploy/compose hosts       # una vez; pide sudo
make -C deploy/compose up          # núcleo + perfiles obs y legacy
make -C deploy/compose bootstrap   # configura WSO2 y Keycloak y corre la prueba de punta a punta
```

Solo para laboratorio: usa credenciales de ejemplo y el certificado autofirmado de WSO2.

## Desarrollo

```bash
pnpm install
pnpm build && pnpm lint && pnpm typecheck && pnpm test
node --test "tools/release/test/*.test.mjs"     # herramientas de versión
node tools/release/verificar-neutralidad.mjs     # el repositorio no nombra clientes
```

El CI (`.github/workflows/ci.yml`) corre en cada push: lint, tipos, pruebas y build; contratos contra la guía de
estilo (D-03); el chart (lint, kubeconform y reglas de seguridad); la neutralidad del repositorio; y Gitleaks y
Trivy (secretos, dependencias y configuración; las excepciones justificadas están en `.trivyignore.yaml`).

## Versiones firmadas, SBOM y vulnerabilidades

Cada versión la publica `.github/workflows/release.yml`, solo desde `main` o desde una etiqueta `v*` y solo si el
CI de ese commit está en verde. La versión en GitHub (<https://github.com/insigne123/yago-nexo/releases>) trae:

- `sbom-nexo-<versión>.cdx.json`: SBOM CycloneDX 1.6 del producto, con los componentes propios `@nexo/*` y los
  de terceros separados en ejecución (`scope: required`) y desarrollo (`scope: excluded`); `LICENCIAS.md`.
- `sbom-imagen-<imagen>.cdx.json`: SBOM de cada imagen (syft), de las propias y de las bases de terceros que usa
  el chart; el de cada imagen propia va además atestado en la imagen.
- `vulnerabilidades-nexo-<versión>.md` y `.json`: tabla completa de grype, sin cortar; `vex-nexo-<versión>.openvex.json`:
  estado de cada vulnerabilidad crítica (OpenVEX); `grype-nexo-<versión>.tar.gz`: resultados completos de grype.
- `IMAGENES.txt` (digests), `CHECKSUMS.txt` y una firma Sigstore (`.sigstore.json`) por cada archivo.

Verificar una versión completa (sumas, firmas, imágenes, SBOM y tabla), como en el caso LAB-PA-055-01:

```bash
tools/release/verificar-version.sh 1.2.0
```

O a mano, un archivo y una imagen:

```bash
IDENTIDAD='^https://github.com/insigne123/yago-nexo/\.github/workflows/release\.yml@refs/(heads/main|tags/v.+)$'
EMISOR=https://token.actions.githubusercontent.com
cosign verify-blob --bundle CHECKSUMS.txt.sigstore.json \
  --certificate-identity-regexp "$IDENTIDAD" --certificate-oidc-issuer "$EMISOR" CHECKSUMS.txt
sha256sum -c CHECKSUMS.txt
cosign verify ghcr.io/insigne123/nexo-console-api:1.2.0 \
  --certificate-identity-regexp "$IDENTIDAD" --certificate-oidc-issuer "$EMISOR"
```

Las notas de cada versión están en `release/<versión>/NOTAS.md` y en <https://yago-nexo.web.app/novedades>.
