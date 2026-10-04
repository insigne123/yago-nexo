# Estado remoto (ejemplo). Sin este bloque, OpenTofu guarda el estado en este directorio (terraform.tfstate),
# que no debe ir al repositorio. Para producción, use un bucket de Cloud Storage con versionado y acceso
# restringido, creado antes y fuera de este módulo:
#
# terraform {
#   backend "gcs" {
#     bucket = "nexo-dr-estado-tofu"
#     prefix = "gcp-dr"
#   }
# }
