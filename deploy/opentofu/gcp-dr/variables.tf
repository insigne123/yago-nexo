# ------------------------------------------------------------------ proyecto
variable "proyecto" {
  description = "ID del proyecto de Google Cloud del sitio de respaldo."
  type        = string
}

variable "region" {
  description = "Región del sitio de respaldo (Santiago)."
  type        = string
  default     = "southamerica-west1"
}

variable "zonas" {
  description = "Zonas de la región donde corren los nodos (clúster regional)."
  type        = list(string)
  default     = ["southamerica-west1-a", "southamerica-west1-b", "southamerica-west1-c"]
}

variable "prefijo" {
  description = "Prefijo de los nombres de los recursos."
  type        = string
  default     = "nexo-dr"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}[a-z0-9]$", var.prefijo))
    error_message = "Use de 3 a 20 caracteres: minúsculas, dígitos y guiones, comenzando con una letra."
  }
}

variable "etiquetas" {
  description = "Etiquetas (labels) que llevan todos los recursos."
  type        = map(string)
  default     = {}
}

variable "activar_apis" {
  description = "Activa las APIs de Google Cloud que usa el módulo."
  type        = bool
  default     = true
}

variable "proteccion_borrado" {
  description = "Impide borrar el clúster con tofu destroy (desactívela solo a propósito)."
  type        = bool
  default     = true
}

# ------------------------------------------------------------------ red
variable "cidr_nodos" {
  description = "Rango principal de la subred de los nodos."
  type        = string
  default     = "10.60.0.0/20"
}

variable "cidr_pods" {
  description = "Rango secundario para los pods (VPC nativa)."
  type        = string
  default     = "10.64.0.0/14"
}

variable "cidr_servicios" {
  description = "Rango secundario para los servicios de Kubernetes."
  type        = string
  default     = "10.68.0.0/20"
}

variable "cidr_plano_control" {
  description = "Rango /28 del plano de control privado de GKE (no debe cruzarse con otras redes)."
  type        = string
  default     = "172.16.0.0/28"
}

variable "redes_cpd" {
  description = "Redes del CPD que llegan por la interconexión o VPN (agentes de continuidad, operación y backends)."
  type        = list(string)
  default     = []
}

variable "redes_autorizadas" {
  description = "Redes que pueden usar la API de Kubernetes del clúster (administración desde el CPD)."
  type = list(object({
    nombre = string
    cidr   = string
  }))
  default = []
}

variable "endpoint_privado" {
  description = "true = la API de Kubernetes solo tiene dirección privada (acceso por la interconexión)."
  type        = bool
  default     = true
}

# ------------------------------------------------------------------ GKE
variable "canal_gke" {
  description = "Canal de versiones de GKE (RAPID, REGULAR o STABLE)."
  type        = string
  default     = "REGULAR"

  validation {
    condition     = contains(["RAPID", "REGULAR", "STABLE"], var.canal_gke)
    error_message = "El canal debe ser RAPID, REGULAR o STABLE."
  }
}

variable "pool_sistema" {
  description = "Nodos para los componentes del sistema y la observabilidad (por zona)."
  type = object({
    tipo_maquina   = string
    nodos_por_zona = number
    disco_gb       = number
  })
  default = {
    tipo_maquina   = "e2-standard-4"
    nodos_por_zona = 1
    disco_gb       = 100
  }
}

variable "pool_plataforma" {
  description = "Nodos de la plataforma en espera tibia (por zona): el mínimo sostiene la mitad del CPD y el autoescalador sube al conmutar."
  type = object({
    tipo_maquina = string
    min_por_zona = number
    max_por_zona = number
    disco_gb     = number
    disco_tipo   = string
  })
  default = {
    tipo_maquina = "n2-standard-8"
    min_por_zona = 1
    max_por_zona = 4
    disco_gb     = 200
    disco_tipo   = "pd-balanced"
  }

  validation {
    condition     = var.pool_plataforma.min_por_zona >= 1 && var.pool_plataforma.max_por_zona >= var.pool_plataforma.min_por_zona
    error_message = "min_por_zona debe ser al menos 1 y max_por_zona no puede ser menor que min_por_zona."
  }
}

variable "kms_llave_secretos" {
  description = "Llave de Cloud KMS para cifrar los Secrets de Kubernetes en etcd (projects/.../cryptoKeys/...). Vacío = cifrado por omisión de Google."
  type        = string
  default     = ""
}

variable "ventana_mantenimiento" {
  description = "Ventana semanal de mantenimiento de GKE (hora UTC, RFC 3339 y regla RRULE)."
  type = object({
    inicio      = string
    fin         = string
    recurrencia = string
  })
  default = {
    inicio      = "2026-01-03T06:00:00Z"
    fin         = "2026-01-03T10:00:00Z"
    recurrencia = "FREQ=WEEKLY;BYDAY=SA,SU"
  }
}

# ------------------------------------------------------------------ registro y DNS
variable "registro_id" {
  description = "ID del repositorio de Artifact Registry para las imágenes de Nexo."
  type        = string
  default     = "nexo"
}

variable "dns_zona_nombre" {
  description = "Nombre de la zona administrada de Cloud DNS (lo usa el agente de continuidad: NEXO_DNS_GCP_ZONE)."
  type        = string
  default     = "nexo-publica"
}

variable "dns_nombre" {
  description = "Dominio de la zona, terminado en punto (por ejemplo nexo.example.)."
  type        = string

  validation {
    condition     = endswith(var.dns_nombre, ".")
    error_message = "El dominio debe terminar en punto, por ejemplo nexo.example."
  }
}

variable "dns_privada" {
  description = "true = zona privada (solo visible desde la VPC); false = zona pública con DNSSEC."
  type        = bool
  default     = false
}
