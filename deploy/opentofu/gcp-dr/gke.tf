# Clúster GKE regional y privado del sitio de respaldo, con Dataplane V2 (aplica las NetworkPolicy del chart),
# Workload Identity, nodos blindados y dos grupos de nodos: sistema y plataforma (espera tibia).

# Cuenta de servicio de los nodos, con solo lo necesario para registros, métricas y descargar imágenes.
resource "google_service_account" "nodos" {
  account_id   = "${var.prefijo}-nodos"
  display_name = "Nexo DR · nodos de GKE"

  depends_on = [google_project_service.apis]
}

locals {
  roles_nodos = [
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/stackdriver.resourceMetadata.writer",
    "roles/autoscaling.metricsWriter",
  ]
}

resource "google_project_iam_member" "nodos" {
  for_each = toset(local.roles_nodos)

  project = var.proyecto
  role    = each.value
  member  = "serviceAccount:${google_service_account.nodos.email}"
}

# Cifrado de los Secrets de Kubernetes con una llave propia (opcional): GKE necesita usar la llave.
resource "google_kms_crypto_key_iam_member" "gke_secretos" {
  count = var.kms_llave_secretos != "" ? 1 : 0

  crypto_key_id = var.kms_llave_secretos
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.actual.number}@container-engine-robot.iam.gserviceaccount.com"
}

resource "google_container_cluster" "dr" {
  name     = var.prefijo
  location = var.region

  node_locations = var.zonas

  network    = google_compute_network.vpc.id
  subnetwork = google_compute_subnetwork.nodos.id

  # Los grupos de nodos se administran aparte.
  remove_default_node_pool = true
  initial_node_count       = 1

  deletion_protection = var.proteccion_borrado

  networking_mode   = "VPC_NATIVE"
  datapath_provider = "ADVANCED_DATAPATH"

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "servicios"
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = var.endpoint_privado
    master_ipv4_cidr_block  = var.cidr_plano_control

    master_global_access_config {
      enabled = false
    }
  }

  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = var.redes_autorizadas
      content {
        display_name = cidr_blocks.value.nombre
        cidr_block   = cidr_blocks.value.cidr
      }
    }
  }

  release_channel {
    channel = var.canal_gke
  }

  workload_identity_config {
    workload_pool = "${var.proyecto}.svc.id.goog"
  }

  enable_shielded_nodes = true

  addons_config {
    http_load_balancing {
      disabled = false
    }
    horizontal_pod_autoscaling {
      disabled = false
    }
    gce_persistent_disk_csi_driver_config {
      enabled = true
    }
  }

  dynamic "database_encryption" {
    for_each = var.kms_llave_secretos != "" ? [var.kms_llave_secretos] : []
    content {
      state    = "ENCRYPTED"
      key_name = database_encryption.value
    }
  }

  logging_config {
    enable_components = ["SYSTEM_COMPONENTS", "WORKLOADS"]
  }

  monitoring_config {
    enable_components = ["SYSTEM_COMPONENTS"]
    managed_prometheus {
      enabled = true
    }
  }

  maintenance_policy {
    recurring_window {
      start_time = var.ventana_mantenimiento.inicio
      end_time   = var.ventana_mantenimiento.fin
      recurrence = var.ventana_mantenimiento.recurrencia
    }
  }

  depends_on = [google_kms_crypto_key_iam_member.gke_secretos]
}

locals {
  config_nodo_comun = {
    image_type = "COS_CONTAINERD"
    scopes     = ["https://www.googleapis.com/auth/cloud-platform"]
  }
}

resource "google_container_node_pool" "sistema" {
  name     = "sistema"
  cluster  = google_container_cluster.dr.id
  location = var.region

  node_locations = var.zonas
  node_count     = var.pool_sistema.nodos_por_zona

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    max_surge       = 1
    max_unavailable = 0
  }

  node_config {
    machine_type    = var.pool_sistema.tipo_maquina
    disk_size_gb    = var.pool_sistema.disco_gb
    disk_type       = "pd-balanced"
    image_type      = local.config_nodo_comun.image_type
    service_account = google_service_account.nodos.email
    oauth_scopes    = local.config_nodo_comun.scopes

    labels = {
      "nexo.yago.cl/pool" = "sistema"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    metadata = {
      disable-legacy-endpoints = "true"
    }
  }
}

# Espera tibia: el mínimo por zona sostiene cerca de la mitad de las instancias del CPD; al conmutar, el HPA
# sube gateways e integrador y el autoescalador agrega nodos hasta el máximo.
resource "google_container_node_pool" "plataforma" {
  name     = "plataforma"
  cluster  = google_container_cluster.dr.id
  location = var.region

  node_locations     = var.zonas
  initial_node_count = var.pool_plataforma.min_por_zona

  autoscaling {
    min_node_count  = var.pool_plataforma.min_por_zona
    max_node_count  = var.pool_plataforma.max_por_zona
    location_policy = "BALANCED"
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    max_surge       = 1
    max_unavailable = 0
  }

  node_config {
    machine_type    = var.pool_plataforma.tipo_maquina
    disk_size_gb    = var.pool_plataforma.disco_gb
    disk_type       = var.pool_plataforma.disco_tipo
    image_type      = local.config_nodo_comun.image_type
    service_account = google_service_account.nodos.email
    oauth_scopes    = local.config_nodo_comun.scopes

    labels = {
      "nexo.yago.cl/pool" = "plataforma"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    metadata = {
      disable-legacy-endpoints = "true"
    }
  }

  lifecycle {
    ignore_changes = [initial_node_count]
  }
}
