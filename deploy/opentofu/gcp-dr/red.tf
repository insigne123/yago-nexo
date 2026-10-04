# Red del sitio de respaldo: VPC propia, subred con rangos para pods y servicios, salida a Internet por
# Cloud NAT (los nodos no tienen IP pública) y reglas de firewall mínimas.

resource "google_compute_network" "vpc" {
  name                    = "${var.prefijo}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"

  depends_on = [google_project_service.apis]
}

resource "google_compute_subnetwork" "nodos" {
  name                     = "${var.prefijo}-nodos"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.cidr_nodos
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.cidr_pods
  }

  secondary_ip_range {
    range_name    = "servicios"
    ip_cidr_range = var.cidr_servicios
  }

  log_config {
    aggregation_interval = "INTERVAL_5_SEC"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_router" "router" {
  name    = "${var.prefijo}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "${var.prefijo}-nat"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.nodos.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# Dirección fija de la entrada del sitio (Traefik detrás de un balanceador regional). Es la IP que el agente
# de continuidad publica en el DNS cuando este sitio queda activo (NEXO_SITE_IP_GCP).
resource "google_compute_address" "entrada" {
  name         = "${var.prefijo}-entrada"
  region       = var.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"
}

# ------------------------------------------------------------------ firewall

# Rangos de Google para las sondas de salud de los balanceadores.
locals {
  rangos_sondas_google = ["35.191.0.0/16", "130.211.0.0/22"]
}

resource "google_compute_firewall" "sondas_salud" {
  name        = "${var.prefijo}-permitir-sondas"
  network     = google_compute_network.vpc.id
  description = "Sondas de salud de los balanceadores de Google hacia la entrada (Traefik)."
  direction   = "INGRESS"
  priority    = 1000

  source_ranges           = local.rangos_sondas_google
  target_service_accounts = [google_service_account.nodos.email]

  allow {
    protocol = "tcp"
    ports    = ["80", "443", "10256", "30000-32767"]
  }
}

resource "google_compute_firewall" "desde_cpd" {
  count = length(var.redes_cpd) > 0 ? 1 : 0

  name        = "${var.prefijo}-permitir-cpd"
  network     = google_compute_network.vpc.id
  description = "Tráfico desde el CPD por la interconexión: entrada HTTPS (continuidad y operación)."
  direction   = "INGRESS"
  priority    = 1000

  source_ranges           = var.redes_cpd
  target_service_accounts = [google_service_account.nodos.email]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}

# Todo lo demás que entra queda denegado y registrado (las reglas de GKE tienen más prioridad).
resource "google_compute_firewall" "denegar_entrada" {
  name        = "${var.prefijo}-denegar-entrada"
  network     = google_compute_network.vpc.id
  description = "Deniega y registra toda entrada no permitida por una regla anterior."
  direction   = "INGRESS"
  priority    = 65000

  source_ranges = ["0.0.0.0/0"]

  deny {
    protocol = "all"
  }

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}
