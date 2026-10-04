# Sitio de respaldo en Google Cloud (OpenTofu)

Crea la infraestructura del sitio de respaldo de Nexo en Google Cloud, región de Santiago
(`southamerica-west1`): red, salida a Internet, clúster GKE privado en espera tibia, registro de imágenes,
zona de Cloud DNS y la cuenta de servicio del agente de continuidad.

Estado: **en desarrollo**. Pasa `tofu fmt -check`, `tofu validate` y `tofu test` (con el proveedor
simulado), pero todavía no se aplica en un proyecto real.

## Qué crea

| Archivo | Recursos |
| --- | --- |
| `apis.tf` | APIs de Compute, GKE, Artifact Registry, Cloud DNS, IAM, Cloud KMS, Logging y Monitoring. |
| `red.tf` | VPC `<prefijo>-vpc`, subred de nodos con rangos secundarios para pods y servicios, Cloud Router y Cloud NAT, IP regional fija de la entrada, y firewall: sondas de salud de Google, entrada desde el CPD (80 y 443) y todo lo demás denegado y registrado. |
| `gke.tf` | Clúster GKE regional en 3 zonas, nodos privados, plano de control privado con redes autorizadas, Dataplane V2 (aplica las NetworkPolicy del chart), Workload Identity, nodos blindados, Managed Prometheus, ventana de mantenimiento, cifrado de Secrets con Cloud KMS (opcional) y dos grupos de nodos: `sistema` y `plataforma` (espera tibia con autoescalamiento). Cuenta de servicio de los nodos con solo registros, métricas y lectura de imágenes. |
| `registro.tf` | Repositorio Docker de Artifact Registry con etiquetas inmutables; los nodos solo leen. |
| `dns.tf` | Zona de Cloud DNS (pública con DNSSEC o privada en la VPC). |
| `continuidad.tf` | Cuenta de servicio del agente de continuidad con un rol propio (8 permisos de Cloud DNS) asignado solo sobre la zona de Nexo. |
| `outputs.tf` | Comando de credenciales, valor de `global.imageRegistry`, IP de entrada, zona y servidores DNS, cuenta del agente. |

El estado se guarda en local por omisión; `backend.tf` trae comentado un ejemplo con Cloud Storage.

## Requisitos

- OpenTofu 1.8 o superior y la CLI `gcloud`, con una cuenta que pueda crear estos recursos en el proyecto
  (por ejemplo, `roles/owner` solo durante la creación, o los roles de administración de cada servicio).
- Interconexión o VPN entre el CPD y la VPC (no la crea este módulo) y rangos que no se crucen con los del CPD.
- El dominio delegado a la zona de Cloud DNS (servidores de la salida `dns_zona.servidores`).

## Pasos

```bash
cd deploy/opentofu/gcp-dr
cp dr.tfvars.example dr.tfvars          # ajuste proyecto, rangos, redes del CPD y dominio
gcloud auth application-default login
tofu init
tofu plan -var-file=dr.tfvars -out=dr.tfplan
tofu apply dr.tfplan
tofu output
```

Después:

1. **Credenciales del clúster:** ejecute el comando de la salida `comando_credenciales` desde una red
   autorizada.
2. **Entrada:** instale Traefik con la IP fija de la salida `ip_entrada`
   (`service.spec.loadBalancerIP`) en el espacio de nombres `traefik`.
3. **Imágenes:** copie las imágenes `nexo/*`, Envoy y Fluent Bit al registro de la salida `registro_imagenes`.
4. **Llave del agente de continuidad** (fuera de OpenTofu, para que no quede en el estado):

   ```bash
   gcloud iam service-accounts keys create sa.json --iam-account "$(tofu output -raw cuenta_continuidad)"
   kubectl -n nexo create secret generic nexo-continuidad --from-file=gcp-sa-key=sa.json \
     --from-literal=primary-db-url='postgres://...' --from-literal=replica-db-url='postgres://...'
   shred -u sa.json
   ```

5. **Plataforma:** `helm upgrade --install nexo-platform ../../helm/nexo-platform -n nexo -f
   ../../helm/nexo-platform/values-gcp-dr.yaml -f sitio-gcp.yaml`.

## Verificación

```bash
tofu output
gcloud container clusters describe nexo-dr --region southamerica-west1 --format='value(status,currentMasterVersion)'
kubectl get nodes -L cloud.google.com/gke-nodepool,topology.kubernetes.io/zone
gcloud dns record-sets list --zone nexo-publica
```

## Volver atrás

- Los cambios se revisan siempre con `tofu plan` antes de aplicar; para deshacer uno, vuelva el archivo
  `dr.tfvars` (o el código) a la versión anterior y aplique de nuevo.
- `tofu destroy` borra todo el sitio, salvo el clúster mientras `proteccion_borrado = true`. La zona DNS y el
  registro se borran con su contenido: respalde antes lo que haga falta.
