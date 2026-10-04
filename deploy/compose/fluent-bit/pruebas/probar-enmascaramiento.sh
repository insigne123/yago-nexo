#!/usr/bin/env bash
# Prueba el filtro enmascarar.lua (BT-029) con la misma imagen de Fluent Bit del laboratorio, sin tocarlo:
# levanta un Fluent Bit aparte con entradas de ejemplo, el filtro y salida a stdout, y compara.
# Uso: deploy/compose/fluent-bit/pruebas/probar-enmascaramiento.sh
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGEN="${FLUENT_BIT_IMAGEN:-fluent/fluent-bit:5.1.3}"

salida="$(timeout 10 docker run --rm \
  -v "$AQUI/..:/fluent-bit/etc/nexo:ro" \
  "$IMAGEN" /fluent-bit/bin/fluent-bit -c /fluent-bit/etc/nexo/pruebas/prueba.yaml 2>/dev/null || true)"
# Fluent Bit escapa los caracteres no ASCII (\u00e9); jq los devuelve como UTF-8 para comparar texto legible.
salida="$(jq -c . <<<"$salida" 2>/dev/null || echo "$salida")"

fallas=0
debe() { # debe <descripción> <texto que debe aparecer>
  if grep -qF -- "$2" <<<"$salida"; then echo "  ok    $1"; else echo "  FALLA $1 (no aparece: $2)"; fallas=$((fallas + 1)); fi
}
no_debe() { # no_debe <descripción> <texto que no debe aparecer>
  if grep -qF -- "$2" <<<"$salida"; then echo "  FALLA $1 (aparece: $2)"; fallas=$((fallas + 1)); else echo "  ok    $1"; fi
}

echo "Enmascaramiento de datos personales en logs (BT-029):"
no_debe "RUT con puntos" "12.345.678-9"
no_debe "RUT sin puntos" "76086428-5"
debe    "RUT reemplazado" "[RUT oculto]"
no_debe "correo: usuario" "ana.perez"
debe    "correo: se conserva el dominio" "***@dominio.cl"
no_debe "teléfono móvil" "9 8765 4321"
debe    "teléfono reemplazado" "[teléfono oculto]"
no_debe "tarjeta" "4111 1111 1111 1111"
debe    "tarjeta reemplazada" "[tarjeta oculta]"
no_debe "token Bearer" "abc.def.ghi"
debe    "Bearer conservado como palabra" "Bearer [token oculto]"
no_debe "JWT suelto" "eyJhbGciOiJIUzI1NiJ9"
no_debe "password en texto libre" "S3creta!"
no_debe "client_secret en JSON" "superSecreto123"
no_debe "campo sensible por nombre" "valor-del-header"
debe    "marca de registro enmascarado" "datos_enmascarados"
debe    "marca de tiempo de 13 dígitos intacta" "1791123845153"
debe    "UUID intacto" "eb0f0056-395a-4352-9e8b-cfb8f50bcbe2"
debe    "registro sin datos personales intacto" "solicitud procesada en 35 ms"

if [ "$fallas" -gt 0 ]; then
  echo "$fallas verificaciones fallaron. Salida de Fluent Bit:"
  echo "$salida"
  exit 1
fi
echo "Todas las verificaciones cumplen."
