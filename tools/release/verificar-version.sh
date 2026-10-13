#!/usr/bin/env bash
# Caso LAB-PA-055-01 (BT-055): verifica una versión publicada de Yago Nexo de punta a punta.
#
#   tools/release/verificar-version.sh <versión> [carpeta]
#
# Sin carpeta, descarga los archivos de la versión desde GitHub (gh release download). Comprueba:
#   1. CHECKSUMS.txt: sha256sum -c sobre todos los archivos.
#   2. Firma Sigstore de cada archivo (cosign verify-blob), emitida por .github/workflows/release.yml desde main o
#      desde una etiqueta v* de este repositorio.
#   3. Firma de cada imagen propia (cosign verify) y su SBOM atestado (cosign verify-attestation --type cyclonedx).
#   4. Cada SBOM (*.cdx.json) válido según el esquema CycloneDX 1.6 (cyclonedx-cli).
#   5. La tabla de vulnerabilidades (Markdown), su JSON y el OpenVEX coinciden (comprobar-vulnerabilidades.mjs).
# Necesita: gh (si descarga), cosign, docker, jq, sha256sum y node 22.
set -euo pipefail

VERSION="${1:?Uso: tools/release/verificar-version.sh <versión> [carpeta]}"
REPO="${NEXO_REPO:-insigne123/yago-nexo}"
RAIZ=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CYCLONEDX="cyclonedx/cyclonedx-cli:0.33.1@sha256:252c2e26f468c25fea1e63ecde1bc3198ad6e9dbb57f5ed3236bddcb2281b3a7"
IDENTIDAD="^https://github.com/${REPO//./\\.}/\\.github/workflows/release\\.yml@refs/(heads/main|tags/v.+)\$"
EMISOR="https://token.actions.githubusercontent.com"

if [ -n "${2:-}" ]; then
  DIR=$(cd "$2" && pwd)
else
  DIR=$(mktemp -d)
  echo "== Descargando v$VERSION de $REPO en $DIR"
  gh release download "v$VERSION" -R "$REPO" -D "$DIR"
fi
cd "$DIR"

echo "== 1. Sumas (CHECKSUMS.txt)"
sha256sum -c CHECKSUMS.txt

echo "== 2. Firmas Sigstore de cada archivo"
n=0
for f in *; do
  case "$f" in *.sigstore.json) continue ;; esac
  [ -f "$f.sigstore.json" ] || { echo "FALTA la firma de $f"; exit 1; }
  cosign verify-blob --bundle "$f.sigstore.json" --certificate-identity-regexp "$IDENTIDAD" \
    --certificate-oidc-issuer "$EMISOR" "$f" >/dev/null 2>&1 || { echo "FIRMA INVÁLIDA: $f"; exit 1; }
  n=$((n + 1))
done
echo "$n archivos con firma válida"

echo "== 3. Imágenes propias firmadas y con SBOM atestado"
while read -r imagen; do
  [ -n "$imagen" ] || continue
  cosign verify "$imagen" --certificate-identity-regexp "$IDENTIDAD" --certificate-oidc-issuer "$EMISOR" >/dev/null
  cosign verify-attestation --type cyclonedx "$imagen" --certificate-identity-regexp "$IDENTIDAD" \
    --certificate-oidc-issuer "$EMISOR" >/dev/null
  echo "OK  $imagen"
done < IMAGENES.txt

echo "== 4. SBOM CycloneDX 1.6 válidos"
for f in *.cdx.json; do
  docker run --rm --network none -v "$DIR:/d:ro" "$CYCLONEDX" validate --input-file "/d/$f" \
    --input-format json --input-version v1_6 --fail-on-errors >/dev/null
  echo "OK  $f ($(jq '.components | length' "$f") componentes)"
done

echo "== 5. Tabla de vulnerabilidades, JSON y OpenVEX"
node "$RAIZ/tools/release/comprobar-vulnerabilidades.mjs" "$DIR" "$VERSION"

echo
echo "LAB-PA-055-01: la versión $VERSION pasó todas las verificaciones ($DIR)."
