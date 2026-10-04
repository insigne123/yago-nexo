# Zona de Cloud DNS con el nombre del sitio activo. El agente de continuidad la actualiza al conmutar
# (proveedor clouddns del motor de continuidad).
resource "google_dns_managed_zone" "nexo" {
  name        = var.dns_zona_nombre
  dns_name    = var.dns_nombre
  description = "Nombres públicos de Yago Nexo; el agente de continuidad reapunta el sitio activo"
  visibility  = var.dns_privada ? "private" : "public"

  dynamic "dnssec_config" {
    for_each = var.dns_privada ? [] : [1]
    content {
      state = "on"
    }
  }

  dynamic "private_visibility_config" {
    for_each = var.dns_privada ? [1] : []
    content {
      networks {
        network_url = google_compute_network.vpc.id
      }
    }
  }

  depends_on = [google_project_service.apis]
}
