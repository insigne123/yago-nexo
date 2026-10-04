# Cuenta de servicio del agente de continuidad con el mínimo privilegio: solo puede leer y cambiar registros
# de la zona de Nexo (rol propio, asignado sobre la zona, no sobre el proyecto).
#
# La llave JSON que usa el agente (NEXO_DNS_GCP_SA_KEY) NO se crea aquí, para que no quede en el estado de
# OpenTofu. Créela aparte y guárdela en el Secret nexo-continuidad (ver README).

resource "google_service_account" "continuidad" {
  account_id   = "${var.prefijo}-continuidad"
  display_name = "Nexo · agente de continuidad (Cloud DNS)"
  description  = "Reapunta el nombre del sitio activo en la zona ${var.dns_zona_nombre} al conmutar"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_custom_role" "continuidad_dns" {
  role_id     = "nexoContinuidadDns"
  title       = "Nexo · cambio de DNS por continuidad"
  description = "Leer la zona y reemplazar registros (cambios atómicos de Cloud DNS)"
  permissions = [
    "dns.managedZones.get",
    "dns.resourceRecordSets.list",
    "dns.resourceRecordSets.get",
    "dns.resourceRecordSets.create",
    "dns.resourceRecordSets.update",
    "dns.resourceRecordSets.delete",
    "dns.changes.create",
    "dns.changes.get",
  ]
}

resource "google_dns_managed_zone_iam_member" "continuidad" {
  project      = var.proyecto
  managed_zone = google_dns_managed_zone.nexo.name
  role         = google_project_iam_custom_role.continuidad_dns.id
  member       = "serviceAccount:${google_service_account.continuidad.email}"
}
