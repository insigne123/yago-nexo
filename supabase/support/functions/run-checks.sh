#!/usr/bin/env bash
# Revisa tipos (deno check) y ejecuta las pruebas (deno test) de las funciones nexo-sd-*.
# Uso: supabase/support/functions/run-checks.sh      (DENO_BIN=/ruta/a/deno si no está en PATH)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DENO="${DENO_BIN:-deno}"

if ! command -v "$DENO" >/dev/null 2>&1; then
  echo "No se encontró deno (instálelo o defina DENO_BIN)." >&2
  exit 2
fi

cd "$HERE"
for fn in nexo-sd-notify nexo-sd-inbound nexo-sd-monthly-report; do
  echo "==> deno check $fn"
  "$DENO" check --quiet --config "$fn/deno.json" "$fn/index.ts"
done

echo "==> deno test"
"$DENO" test --quiet --config tests/deno.json tests/
