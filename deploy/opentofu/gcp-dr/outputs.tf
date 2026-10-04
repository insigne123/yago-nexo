output "cluster" {
  description = "Nombre y región del clúster GKE."
  value       = { nombre = google_container_cluster.dr.name, region = var.region }
}

output "comando_credenciales" {
  description = "Comando para obtener el kubeconfig del clúster (desde una red autorizada)."
  value       = "gcloud container clusters get-credentials ${google_container_cluster.dr.name} --region ${var.region} --project ${var.proyecto}${var.endpoint_privado ? " --internal-ip" : ""}"
}

output "registro_imagenes" {
  description = "Valor de global.imageRegistry en values-gcp-dr.yaml."
  value       = "${var.region}-docker.pkg.dev/${var.proyecto}/${google_artifact_registry_repository.nexo.repository_id}"
}

output "ip_entrada" {
  description = "IP fija de la entrada del sitio: loadBalancerIP de Traefik y NEXO_SITE_IP_GCP del agente de continuidad."
  value       = google_compute_address.entrada.address
}

output "dns_zona" {
  description = "Zona de Cloud DNS (NEXO_DNS_GCP_ZONE) y servidores de nombres para delegar el dominio."
  value = {
    nombre     = google_dns_managed_zone.nexo.name
    dominio    = google_dns_managed_zone.nexo.dns_name
    servidores = google_dns_managed_zone.nexo.name_servers
  }
}

output "cuenta_continuidad" {
  description = "Cuenta de servicio del agente de continuidad (crear su llave aparte)."
  value       = google_service_account.continuidad.email
}

output "red" {
  description = "VPC y subred del sitio."
  value       = { vpc = google_compute_network.vpc.name, subred = google_compute_subnetwork.nodos.name }
}
