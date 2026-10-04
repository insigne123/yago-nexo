# Yago Nexo · sitio de respaldo en Google Cloud (OpenTofu).
terraform {
  required_version = ">= 1.8.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
  }
}

provider "google" {
  project = var.proyecto
  region  = var.region
  default_labels = merge(var.etiquetas, {
    plataforma = "nexo"
    sitio      = "gcp"
  })
}
