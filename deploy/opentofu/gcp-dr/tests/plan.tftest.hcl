# Prueba sin credenciales: el proveedor de Google se simula (mock_provider) y se revisa el plan.
#   tofu test
mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }
}

variables {
  proyecto   = "nexo-dr-prueba"
  dns_nombre = "nexo.example."
  redes_cpd  = ["10.10.0.0/16"]
  redes_autorizadas = [
    { nombre = "administracion-cpd", cidr = "10.10.10.0/24" },
  ]
  kms_llave_secretos = "projects/nexo-dr-prueba/locations/southamerica-west1/keyRings/nexo/cryptoKeys/gke"
}

run "plan_del_sitio_de_respaldo" {
  command = plan

  assert {
    condition     = google_container_cluster.dr.private_cluster_config[0].enable_private_nodes
    error_message = "Los nodos deben ser privados."
  }

  assert {
    condition     = google_container_cluster.dr.datapath_provider == "ADVANCED_DATAPATH"
    error_message = "Se necesita Dataplane V2 para aplicar las NetworkPolicy del chart."
  }

  assert {
    condition     = google_container_node_pool.plataforma.name == "plataforma"
    error_message = "values-gcp-dr.yaml espera el grupo de nodos \"plataforma\"."
  }

  assert {
    condition     = google_container_node_pool.plataforma.autoscaling[0].min_node_count >= 1
    error_message = "La espera tibia necesita al menos un nodo por zona."
  }

  assert {
    condition     = length(google_compute_firewall.desde_cpd) == 1
    error_message = "Con redes_cpd definidas debe existir la regla desde el CPD."
  }

  assert {
    condition     = google_dns_managed_zone.nexo.visibility == "public"
    error_message = "Por omisión la zona es pública."
  }

  assert {
    condition     = google_dns_managed_zone_iam_member.continuidad.managed_zone == "nexo-publica"
    error_message = "El permiso del agente de continuidad va sobre la zona, no sobre el proyecto."
  }

  assert {
    condition     = length(google_project_iam_custom_role.continuidad_dns.permissions) == 8
    error_message = "El rol del agente de continuidad solo tiene los permisos de DNS necesarios."
  }

  assert {
    condition     = length(google_kms_crypto_key_iam_member.gke_secretos) == 1
    error_message = "Con kms_llave_secretos, GKE debe poder usar la llave."
  }
}

run "zona_privada_sin_dnssec" {
  command = plan

  variables {
    dns_privada        = true
    redes_cpd          = []
    kms_llave_secretos = ""
  }

  assert {
    condition     = google_dns_managed_zone.nexo.visibility == "private" && length(google_dns_managed_zone.nexo.dnssec_config) == 0
    error_message = "Una zona privada no lleva DNSSEC."
  }

  assert {
    condition     = length(google_compute_firewall.desde_cpd) == 0
    error_message = "Sin redes_cpd no se crea la regla desde el CPD."
  }
}
