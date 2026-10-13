# Yago Nexo 1.2.0

> Borrador para el integrador: completar con los cambios de producto de esta versión (sección «Producto») y
> revisar las fechas antes de publicar. El flujo de versión usa este archivo como notas de la versión en GitHub.

Fecha de publicación: 09-10-2026 (por confirmar). Base: WSO2 API Manager 4.7.0 y WSO2 Micro Integrator 4.6.0.

## Producto

- _(completar: cambios de la Consola, motores, auditoría, alertas, integración y exportación incluidos en 1.2.0)_
- La API de la Consola informa la versión real del producto (la de su package.json, 1.2.0) en el laboratorio,
  donde antes decía 0.1.0; en Kubernetes la sigue fijando el chart con su appVersion.

## Instalación (chart nexo-platform 1.2.0)

- El chart sube a `version` y `appVersion` 1.2.0, igual que el producto.
- Todos los contenedores corren con la raíz de solo lectura. Los servidores WSO2 (Control Plane, Traffic
  Manager, Universal Gateways y Micro Integrator) corren sobre una copia escribible de `/home/wso2carbon` en un
  emptyDir, preparada por un contenedor de inicio, y `/tmp` en otro emptyDir (`almacenamiento.hogar` y
  `almacenamiento.temporal` por componente).
- Los `deployment.toml` de WSO2 pasan de ConfigMaps a Secrets (`<componente>-config`): nombran contraseñas y, sin
  `secretos.almacenLlaves.existingSecret`, traen la de los almacenes de ejemplo.
- Los pods de WSO2 corren con el uid de sus imágenes oficiales (10001 en API Manager y 10802 en Micro
  Integrator; valores `apim.uidImagen` y `mi.uidImagen`). Con el uid anterior (802) no podían leer
  `/home/wso2carbon`.
- El esquema de API Manager recibe la contraseña de la base en `PGPASSWORD` directamente desde su Secret.
- `deploy/validar-instaladores.sh` revisa además que ningún contenedor quede sin raíz de solo lectura ni corra
  como root y que ningún `deployment.toml` vuelva a un ConfigMap; con `--solo-helm` valida solo el chart.
- Versiones únicas en instaladores y documentación del despliegue: RKE2 v1.36.5+rke2r1 y PostgreSQL 16.

## Versión firmada, SBOM y vulnerabilidades

- El flujo de versión corre solo desde `main` o desde una etiqueta `v*`, exige el CI en verde en el mismo commit
  y fija todas las acciones por SHA (también en el CI).
- SBOM CycloneDX 1.6 del producto con los componentes propios `@nexo/*`, purls corregidos (`%40` en los scopes de
  npm, imágenes y repositorios correctos) y los componentes de terceros separados en ejecución y desarrollo.
- SBOM de cada imagen con syft (propias y bases de terceros del chart), validados con cyclonedx-cli, firmados y,
  en las propias, atestados en la imagen.
- Tabla de vulnerabilidades de grype en Markdown y JSON, completa, y documento OpenVEX con el estado de cada
  crítica. Verificación de punta a punta: `tools/release/verificar-version.sh 1.2.0` (caso LAB-PA-055-01).
- Guarda de neutralidad en el CI: el repositorio es público y no nombra clientes; el job falla si aparece un
  nombre vetado (sin distinguir mayúsculas).

## CI

- Corrige los dos jobs en rojo de la versión anterior: Trivy (configuración del chart: raíz de solo lectura y
  contraseñas fuera de ConfigMaps) y contratos D-03 (construye las dependencias del workspace antes de validar).
- Nuevos jobs: neutralidad y herramientas de versión; chart de Helm (lint, kubeconform y reglas de seguridad).
- Excepciones de Trivy documentadas una por una en `.trivyignore.yaml` (con plazo cuando corresponde).

## Verificación

```bash
tools/release/verificar-version.sh 1.2.0
```
