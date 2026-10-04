# APIs de Google Cloud que usa el sitio de respaldo.
locals {
  apis = [
    "compute.googleapis.com",
    "container.googleapis.com",
    "artifactregistry.googleapis.com",
    "dns.googleapis.com",
    "iam.googleapis.com",
    "cloudkms.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each = var.activar_apis ? toset(local.apis) : toset([])

  project            = var.proyecto
  service            = each.value
  disable_on_destroy = false
}

data "google_project" "actual" {
  project_id = var.proyecto
}
