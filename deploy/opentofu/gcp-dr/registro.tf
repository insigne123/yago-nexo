# Registro de imágenes del sitio: las mismas imágenes nexo/* del CPD, copiadas aquí. Las etiquetas son
# inmutables (una versión publicada no cambia).
resource "google_artifact_registry_repository" "nexo" {
  repository_id = var.registro_id
  location      = var.region
  format        = "DOCKER"
  description   = "Imágenes de Yago Nexo para el sitio de respaldo"

  docker_config {
    immutable_tags = true
  }

  depends_on = [google_project_service.apis]
}

# Los nodos solo pueden leer imágenes de este repositorio.
resource "google_artifact_registry_repository_iam_member" "nodos_lectura" {
  repository = google_artifact_registry_repository.nexo.name
  location   = google_artifact_registry_repository.nexo.location
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.nodos.email}"
}
