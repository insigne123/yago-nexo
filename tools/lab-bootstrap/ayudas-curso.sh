# shellcheck shell=bash
# Ayudas de terminal para los ejercicios del curso Yago Nexo en el laboratorio local (deploy/compose).
# No cambian el laboratorio: solo abrevian llamadas que se repiten (tokens, API de la Consola, nexo-ctl).
#
# Uso, desde la raíz del repositorio y en bash o zsh:
#   source tools/lab-bootstrap/ayudas-curso.sh
#
# Requiere curl y jq, y los nombres del laboratorio en /etc/hosts (make -C deploy/compose hosts).
# Solo para el laboratorio: usa las credenciales de ejemplo de deploy/compose/.env.

NEXO_RAIZ="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
export NEXO_RAIZ
export CONSOLA="${CONSOLA:-http://localhost:8090/api/v1}"
export KEYCLOAK_REALM_URL="${KEYCLOAK_REALM_URL:-http://keycloak:8080/realms/nexo}"
export NEXO_LAB_USER_PASSWORD="${NEXO_LAB_USER_PASSWORD:-Nexo-Lab-2026!}"

# Credenciales del laboratorio (APIM_ADMIN_PASSWORD, MI_ADMIN_PASSWORD, RABBITMQ_PASSWORD, ...).
if [ -f "$NEXO_RAIZ/deploy/compose/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$NEXO_RAIZ/deploy/compose/.env"
  set +a
fi

# Token de una persona del realm nexo (cliente nexo-console).   Ej.: tok luis.aprobador
tok() {
  curl -s "$KEYCLOAK_REALM_URL/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=nexo-console -d scope=openid \
    --data-urlencode "username=$1" --data-urlencode "password=$NEXO_LAB_USER_PASSWORD" | jq -r .access_token
}

# Llamada a la API de la Consola como una persona.   Ej.: consola luis.aprobador GET /continuity
#                                                         consola ana.desarrollo POST /impact/simulate '{"nodeId":"..."}'
consola() {
  local usuario="$1" metodo="$2" ruta="$3" cuerpo="${4:-}" t
  t="$(tok "$usuario")" || return 1
  if [ -n "$cuerpo" ]; then
    curl -s -X "$metodo" -H "Authorization: Bearer $t" -H "content-type: application/json" -d "$cuerpo" "$CONSOLA$ruta"
  else
    curl -s -X "$metodo" -H "Authorization: Bearer $t" "$CONSOLA$ruta"
  fi
  echo
}

# Igual que consola, pero muestra solo el código HTTP.   Ej.: consola_estado ana.desarrollo GET /audit-events
consola_estado() {
  local usuario="$1" metodo="$2" ruta="$3" cuerpo="${4:-}" t
  t="$(tok "$usuario")" || return 1
  if [ -n "$cuerpo" ]; then
    curl -s -o /dev/null -w '%{http_code}\n' -X "$metodo" -H "Authorization: Bearer $t" -H "content-type: application/json" -d "$cuerpo" "$CONSOLA$ruta"
  else
    curl -s -o /dev/null -w '%{http_code}\n' -X "$metodo" -H "Authorization: Bearer $t" "$CONSOLA$ruta"
  fi
}

# Consumer key y consumer secret (producción, Keycloak) de una aplicación del Dev Portal del usuario admin.
#   Ej.: app_llaves OperadorDemo
app_llaves() {
  local nombre="${1:-OperadorDemo}" id
  id="$(curl -sk -u "admin:${APIM_ADMIN_PASSWORD:-admin}" "https://apim:9443/api/am/devportal/v3/applications?limit=500" |
    jq -r --arg n "$nombre" '.list[] | select(.name == $n) | .applicationId')"
  if [ -z "$id" ]; then
    echo "no existe la aplicación $nombre en el Dev Portal" >&2
    return 1
  fi
  curl -sk -u "admin:${APIM_ADMIN_PASSWORD:-admin}" "https://apim:9443/api/am/devportal/v3/applications/$id/oauth-keys" |
    jq -r '.list[] | select(.keyManager == "Keycloak" and .keyType == "PRODUCTION") | "\(.consumerKey) \(.consumerSecret)"'
}

# Token client_credentials de una aplicación, emitido por Keycloak.   Ej.: APP=$(app_tok OperadorDemo)
app_tok() {
  local llaves ck cs
  llaves="$(app_llaves "${1:-OperadorDemo}")" || return 1
  read -r ck cs <<<"$llaves"
  curl -s -u "$ck:$cs" -d grant_type=client_credentials "$KEYCLOAK_REALM_URL/protocol/openid-connect/token" | jq -r .access_token
}

# nexo-ctl desde la raíz del repositorio (las rutas que reciba son relativas a la raíz).
#   Ej.: nexo-ctl api lint wso2/apim/apis/concesiones/openapi.yaml
nexo-ctl() {
  (cd "$NEXO_RAIZ" && tools/nexo-ctl/node_modules/.bin/tsx tools/nexo-ctl/src/cli.ts "$@")
}

# Management API de Micro Integrator.   Ej.: mi_api /apis   ·   mi_api /inbound-endpoints
mi_api() {
  local t
  t="$(curl -sk -u "admin:${MI_ADMIN_PASSWORD:-admin}" https://localhost:9164/management/login | jq -r .AccessToken)" || return 1
  curl -sk -H "Authorization: Bearer $t" "https://localhost:9164/management$1"
  echo
}

# Falla simulada de un backend de ejemplo (proporción de 0 a 1). Puerto 7001 = concesiones 1.0.0, 7011 = 1.1.0.
#   Ej.: caos 1   (todo falla)   ·   caos 0   (vuelve a la normalidad)
caos() {
  curl -s -X POST "http://localhost:${2:-7001}/_chaos" -H "x-chaos-token: nexo-lab-chaos" \
    -H "content-type: application/json" -d "{\"failRate\": ${1:-0}}"
  echo
}

echo "Ayudas del laboratorio Nexo cargadas: tok, consola, consola_estado, app_llaves, app_tok, nexo-ctl, mi_api, caos"
