---
title: Google Cloud con GKE
description: Sitio de respaldo de Nexo en Google Cloud (southamerica-west1). Red, GKE privado en espera tibia, Artifact Registry y Cloud DNS con OpenTofu, y la plataforma con Helm; requisitos, pasos, verificación y vuelta atrás.
---

import EstadoCapacidad from '@site/src/components/EstadoCapacidad';

# Google Cloud con GKE

Estado: <EstadoCapacidad id="instalador-gke" /> · chart: <EstadoCapacidad id="helm" /> · continuidad: <EstadoCapacidad id="motor-continuidad" />

El sitio de respaldo corre el mismo chart que el CPD, en **espera tibia**: cerca de la mitad de las instancias (mínimo una por componente), con los mismos recursos por pod, y una réplica de PostgreSQL en espera. Si el CPD cae, el agente de continuidad promueve la réplica y cambia el DNS; el autoescalamiento sube los gateways y el integrador.

## Qué crea OpenTofu {#que-crea}

El módulo `deploy/opentofu/gcp-dr` crea, en la región de Santiago (`southamerica-west1`):

| Recurso | Detalle |
| --- | --- |
| Red | VPC propia, subred de nodos con rangos para pods y servicios, Cloud NAT para la salida (los nodos no tienen IP pública) e IP regional fija para la entrada del sitio. |
| Firewall | Sondas de salud de Google y entrada desde el CPD (80 y 443) hacia los nodos; todo lo demás que entra queda denegado y registrado. |
| GKE | Clúster regional en 3 zonas, nodos y plano de control privados, redes autorizadas para administrar, Dataplane V2 (aplica las políticas de red del chart), Workload Identity, nodos blindados, Managed Prometheus y cifrado de Secrets con Cloud KMS (opcional). |
| Grupos de nodos | `sistema` (componentes del clúster) y `plataforma` (Nexo), este último con autoescalamiento entre un mínimo de espera y un máximo para cuando el sitio quede activo. |
| Artifact Registry | Repositorio Docker con etiquetas inmutables; los nodos solo pueden leer. |
| Cloud DNS | Zona del dominio de Nexo (pública con DNSSEC, o privada). |
| Cuenta del agente de continuidad | Rol propio con 8 permisos de Cloud DNS, asignado solo sobre la zona de Nexo. |

El estado de OpenTofu queda en local por omisión; `backend.tf` trae comentado un ejemplo con Cloud Storage.

## Requisitos {#requisitos}

- Proyecto de Google Cloud y una cuenta que pueda crear red, GKE, Artifact Registry, Cloud DNS e IAM.
- OpenTofu 1.8 o superior, `gcloud`, `kubectl` y Helm.
- Interconexión o VPN entre el CPD y la VPC (este módulo no la crea), con rangos que no se crucen.
- El dominio de Nexo delegado a la zona de Cloud DNS, y los nombres públicos como alias (CNAME) del nombre del sitio activo, por ejemplo `activo.nexo.example`.
- La réplica de PostgreSQL del sitio, alimentada por replicación desde el primario del CPD.
- El CPD ya instalado ([CPD con RKE2](./cpd-rke2.md)): la llave de cifrado de WSO2 debe ser la misma en ambos sitios.

## Pasos {#pasos}

1. **Variables del sitio.**

   ```bash
   cd deploy/opentofu/gcp-dr
   cp dr.tfvars.example dr.tfvars   # proyecto, rangos, redes del CPD, redes autorizadas y dominio
   ```

   `dr.tfvars` no va al repositorio. `pool_plataforma` fija la espera tibia: con `min_por_zona = 2` hay 6 nodos de 8 vCPU y 32 GB (cerca de la mitad de los 11 del CPD) y con `max_por_zona = 4` el sitio puede llegar a 12.

2. **Crear la infraestructura.**

   ```bash
   gcloud auth application-default login
   tofu init
   tofu plan -var-file=dr.tfvars -out=dr.tfplan
   tofu apply dr.tfplan
   tofu output
   ```

3. **Credenciales del clúster** desde una red autorizada: ejecute el comando de la salida `comando_credenciales`.

4. **Entrada del sitio.** Instale Traefik en el espacio de nombres `traefik` con un Service de tipo LoadBalancer y la IP de la salida `ip_entrada` (`service.spec.loadBalancerIP`). Es el mismo controlador que en el CPD, y deja una sola IP de entrada por sitio: la que el agente de continuidad publica en el DNS.

5. **Imágenes.** Copie al registro de la salida `registro_imagenes` las mismas imágenes que usa el CPD (`nexo/*`, Envoy y Fluent Bit).

6. **Secrets.** Cree en el espacio de nombres `nexo` los mismos Secrets del CPD (con la misma `encryption-key`) y el del agente de continuidad. La llave de su cuenta de servicio se crea aparte, para que no quede en el estado de OpenTofu:

   ```bash
   gcloud iam service-accounts keys create sa.json --iam-account "$(tofu output -raw cuenta_continuidad)"
   kubectl -n nexo create secret generic nexo-continuidad --from-file=gcp-sa-key=sa.json \
     --from-literal=primary-db-url='postgres://<usuario>:<contraseña>@<primario-cpd>:5432/postgres' \
     --from-literal=replica-db-url='postgres://<usuario>:<contraseña>@<réplica-local>:5432/postgres'
   shred -u sa.json
   ```

7. **Plataforma.** Ajuste en un archivo propio del sitio el proyecto y la zona de Cloud DNS, las IP de entrada de ambos sitios y las direcciones de los servicios, y despliegue:

   ```bash
   helm upgrade --install nexo-platform deploy/helm/nexo-platform -n nexo \
     -f deploy/helm/nexo-platform/values-gcp-dr.yaml -f sitio-gcp.yaml \
     --wait --timeout 30m
   ```

   En este sitio el Control Plane no aplica el esquema de la base ni registra el Key Manager: ambos llegan por la replicación desde el CPD.

## Verificación {#verificacion}

```bash
tofu output
gcloud container clusters describe nexo-dr --region southamerica-west1 --format='value(status)'   # RUNNING
kubectl get nodes -L cloud.google.com/gke-nodepool,topology.kubernetes.io/zone   # nodos en 3 zonas
kubectl -n nexo get pods -o wide        # 1 réplica de cada componente, repartidas por zona
kubectl -n nexo get hpa                 # gateways e integrador con mínimo 1
kubectl -n nexo logs deploy/nexo-platform-continuidad | tail   # el agente vota como "respaldo"
gcloud dns record-sets list --zone nexo-publica   # el nombre del sitio activo apunta al CPD
```

En la Consola del CPD, la vista de continuidad debe mostrar el agente de Google Cloud junto al del CPD, con el CPD como sitio activo (el agente de respaldo deja su latido en la base del CPD: `continuidad.baseNexoHost`).

Mientras sea respaldo, la base local está en solo lectura: los portales de este sitio permiten consultar, pero publicar APIs o crear aplicaciones falla hasta que se promueva la réplica.

## Vuelta atrás {#vuelta-atras}

| Qué | Cómo |
| --- | --- |
| Una actualización de la plataforma | `helm -n nexo history nexo-platform` y `helm -n nexo rollback nexo-platform <revisión> --wait`. |
| Un cambio de infraestructura | Vuelva `dr.tfvars` (o el código) a la versión anterior, revise con `tofu plan -var-file=dr.tfvars` y aplique. |
| Una conmutación al respaldo | El retorno al CPD es guiado y lo aprueba una persona con rol aprobador desde la Consola ([Arquitectura](../arquitectura.md#continuidad-entre-sitios)). |
| Retirar el sitio | `tofu destroy -var-file=dr.tfvars`. El clúster queda protegido mientras `proteccion_borrado = true`; la zona DNS y el registro se borran con su contenido. |

## Pendiente {#pendiente}

- La promoción de la réplica la hace hoy el agente con `pg_promote()` sobre una réplica PostgreSQL por streaming. Con CloudNativePG en modo réplica (opción del chart), la promoción debe pasar por el operador; esa integración está pendiente.
- El primer ensayo de conmutación con los dos sitios reales, con RTO y RPO medidos.
