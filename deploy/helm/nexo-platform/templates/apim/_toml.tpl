{{/*
deployment.toml de WSO2 API Manager 4.7.0, generados desde los valores. Misma intención que la configuración
del laboratorio (deploy/compose/apim y deploy/compose/gateway-publico), separada en Control Plane, Traffic
Manager y Universal Gateway. Las contraseñas nunca se escriben aquí: WSO2 las lee de variables de entorno
($env{...}) que vienen de Secrets.
*/}}

{{/* Secciones comunes a todos los nodos de API Manager. Recibe ctx. */}}
{{- define "nexo.toml.comun" -}}
{{- $ks := .ctx.Values.secretos.almacenLlaves -}}
{{- $pass := "wso2carbon" -}}
{{- if $ks.existingSecret }}{{ $pass = "$env{WSO2_KEYSTORE_PASSWORD}" }}{{ end -}}
[super_admin]
username = {{ .ctx.Values.apim.usuarioAdmin | quote }}
password = "$env{APIM_ADMIN_PASSWORD}"
create_admin_account = true

[user_store]
type = "database_unique_id"

# Llave de cifrado interno: la misma en todos los nodos y en ambos sitios.
[encryption]
key = "$env{APIM_ENCRYPTION_KEY}"

[keystore.primary]
file_name = {{ $ks.archivos.keystore | quote }}
type = "JKS"
password = {{ $pass | quote }}
alias = {{ $ks.alias | quote }}
key_password = {{ $pass | quote }}

[keystore.tls]
file_name = {{ $ks.archivos.keystore | quote }}
type = "JKS"
password = {{ $pass | quote }}
alias = {{ $ks.alias | quote }}
key_password = {{ $pass | quote }}

[truststore]
file_name = {{ $ks.archivos.truststore | quote }}
type = "JKS"
password = {{ $pass | quote }}

# TLS: solo protocolos vigentes.
[transport.https.sslHostConfig.properties]
protocols = {{ .ctx.Values.apim.protocolosTls | quote }}

[transport.passthru_https.listener.parameters]
HttpsProtocols = {{ .ctx.Values.apim.protocolosTls | quote }}
{{- end -}}

{{/* Bases apim_db y shared_db. Recibe ctx. */}}
{{- define "nexo.toml.bases" -}}
{{- $pg := .ctx.Values.global.dependencias.postgresql -}}
{{- range $id, $base := dict "apim_db" $pg.bases.apim "shared_db" $pg.bases.compartida }}
[database.{{ $id }}]
type = "postgre"
url = {{ include "nexo.pg.jdbc" (dict "ctx" $.ctx "base" $base) | quote }}
username = {{ $pg.usuarios.apim | quote }}
password = "$env{APIM_DB_PASSWORD}"
driver = "org.postgresql.Driver"
validationQuery = "SELECT 1"

[database.{{ $id }}.pool_options]
maxActive = 50
maxWait = 60000
testOnBorrow = true
validationInterval = 30000
{{ end }}
{{- end -}}

{{/* Trazas OpenTelemetry. Recibe ctx. */}}
{{- define "nexo.toml.otel" -}}
{{- if .ctx.Values.global.otel.enabled }}
[apim.open_telemetry]
remote_tracer.enable = true
remote_tracer.name = "otlp"
remote_tracer.url = {{ .ctx.Values.global.otel.endpoint | quote }}
{{- end }}
{{- end -}}

{{/* ------------------------------------------------------------------ Control Plane */}}
{{- define "nexo.toml.cp" -}}
{{- $cp := .Values.apim.controlPlane -}}
{{- $cpSvc := include "nexo.dns" (dict "ctx" . "comp" "apim-cp") -}}
# Yago Nexo · WSO2 API Control Plane 4.7.0 (Publisher, Developer Portal, Admin y Key Manager residente).
# Generado por el chart nexo-platform; no editar en el pod.

[server]
hostname = {{ $cp.hostname | quote }}
node_ip = "$env{NODE_IP}"
base_path = "${carbon.protocol}://${carbon.host}:${carbon.management.port}"
server_role = "default"

# Los portales se publican por el Ingress en el puerto 443.
[transport.https.properties]
proxyPort = 443

{{ include "nexo.toml.comun" (dict "ctx" .) }}
{{ include "nexo.toml.bases" (dict "ctx" .) }}

[apim]
gateway_type = "Regular"

# Ambientes de gateway: uno por audiencia (y por etapa en dev y qa). Las APIs se despliegan en ellos.
{{- range $clave := splitList "," (include "nexo.gateways" .) }}
{{- if $clave }}
{{- $gw := fromYaml (include "nexo.gatewayCfg" (dict "ctx" $ "clave" $clave)) }}
{{- $gwSvc := include "nexo.dns" (dict "ctx" $ "comp" (printf "gw-%s" $clave)) }}
{{- $ws := "" }}
{{- with $gw.ingress.websocket }}{{ $ws = (first .).host }}{{ end }}
{{- range $amb := $gw.ambientes }}

[[apim.gateway.environment]]
name = {{ $amb.nombre | quote }}
type = "hybrid"
gateway_type = "Regular"
provider = "wso2"
display_in_api_console = true
description = {{ default "" $amb.descripcion | quote }}
show_as_token_endpoint_url = true
service_url = "https://{{ $gwSvc }}:9443/services/"
username = "${admin.username}"
password = "${admin.password}"
{{- if $ws }}
ws_endpoint = "ws://{{ $ws }}"
wss_endpoint = "wss://{{ $ws }}"
{{- else }}
ws_endpoint = "ws://{{ $amb.vhost }}:9099"
wss_endpoint = "wss://{{ $amb.vhost }}:8099"
{{- end }}
http_endpoint = "http://{{ $amb.vhost }}"
https_endpoint = "https://{{ $amb.vhost }}"
websub_event_receiver_http_endpoint = "http://{{ $amb.vhost }}:9021"
websub_event_receiver_https_endpoint = "https://{{ $amb.vhost }}:8021"
{{- end }}
{{- end }}
{{- end }}

[apim.key_manager]
service_url = "https://{{ $cpSvc }}:9443/services/"
username = "$ref{super_admin.username}"
password = "$ref{super_admin.password}"
enable_lightweight_apikey_generation = true

# Centro de eventos: los gateways y el Traffic Manager se suscriben al JMS (5672) de cada nodo.
[apim.event_hub]
enable = true
username = "$ref{super_admin.username}"
password = "$ref{super_admin.password}"
service_url = "https://{{ $cpSvc }}:9443/services/"
event_listening_endpoints = ["tcp://localhost:5672"]
{{- if gt (int $cp.replicas) 1 }}
# Los demás nodos del Control Plane (lo completa el contenedor de inicio, sin el propio nodo).
event_duplicate_url = [@@PARES_EVENTOS@@]
{{- end }}
{{- range $i := until (int $cp.replicas) }}

[[apim.event_hub.publish.url_group]]
urls = ["tcp://{{ include "nexo.dnsPar" (dict "ctx" $ "comp" "apim-cp" "i" $i) }}:9611"]
auth_urls = ["ssl://{{ include "nexo.dnsPar" (dict "ctx" $ "comp" "apim-cp" "i" $i) }}:9711"]
{{- end }}

[apim.oauth_config]
revoke_endpoint = "https://{{ $cpSvc }}:9443/oauth2/revoke"

[[oauth.extensions.token_types]]
name = "JWT"
issuer = "org.wso2.is.key.manager.tokenpersistence.issuer.ExtendedJWTTokenIssuer"

[oauth.grant_type.token_exchange]
enable = true
allow_refresh_tokens = true
iat_validity_period = "1h"

[apim.devportal]
url = "https://{{ $cp.hostname }}/devportal"

# Analítica en modo log (ELK): los eventos van a apim_metrics.log y Fluent Bit los envía a OpenSearch.
[apim.analytics]
enable = true
type = "elk"

# Funciones de IA que dependen de servicios externos de WSO2: apagadas.
[apim.ai]
enable = false
{{ include "nexo.toml.otel" (dict "ctx" .) }}

# Autorregistro en el portal de desarrolladores; la cuenta queda pendiente de aprobación.
[identity_mgt.user_self_registration]
allow_self_registration = {{ $cp.autoRegistro }}
lock_on_creation = false

[[event_handler]]
name = "userPostSelfRegistration"
subscriptions = ["POST_ADD_USER"]

# Generación de SDK.
[apim.sdk]
group_id = {{ $cp.sdk.grupo | quote }}
artifact_id = {{ printf "%s.client." $cp.sdk.grupo | quote }}
model_package = {{ printf "%s.client.model." $cp.sdk.grupo | quote }}
api_package = {{ printf "%s.client.api." $cp.sdk.grupo | quote }}
supported_languages = {{ toJson $cp.sdk.lenguajes }}

[apim.cors]
allow_origins = {{ $cp.cors.origenes | quote }}
allow_methods = ["GET", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"]
allow_headers = ["authorization", "Access-Control-Allow-Origin", "Content-Type", "SOAPAction", "apikey", "Internal-Key", "X-Correlation-ID"]
allow_credentials = false

[service_provider]
sp_name_regex = "^[\\sa-zA-Z0-9._-]*$"

[database.local]
url = "jdbc:h2:./repository/database/WSO2CARBON_DB;DB_CLOSE_ON_EXIT=FALSE;DB_CLOSE_DELAY=-1"

[[event_listener]]
id = "token_revocation"
type = "org.wso2.carbon.identity.core.handler.AbstractIdentityHandler"
name = "org.wso2.is.notification.ApimOauthEventInterceptor"
order = 1
[event_listener.properties]
notification_endpoint = "https://localhost:${mgt.transport.https.port}/internal/data/v1/notify"
username = "${admin.username}"
password = "${admin.password}"
'header.X-WSO2-KEY-MANAGER' = "default"
{{- end -}}

{{/* ------------------------------------------------------------------ Traffic Manager */}}
{{- define "nexo.toml.tm" -}}
{{- $tm := .Values.apim.trafficManager -}}
{{- $cp := .Values.apim.controlPlane -}}
{{- $cpSvc := include "nexo.dns" (dict "ctx" . "comp" "apim-cp") -}}
{{- $tmSvc := include "nexo.dns" (dict "ctx" . "comp" "apim-tm") -}}
# Yago Nexo · WSO2 Traffic Manager 4.7.0 (decisiones de límites de uso).
# Generado por el chart nexo-platform; no editar en el pod.

[server]
hostname = {{ $tmSvc | quote }}
node_ip = "$env{NODE_IP}"
server_role = "default"

{{ include "nexo.toml.comun" (dict "ctx" .) }}
{{ include "nexo.toml.bases" (dict "ctx" .) }}

[apim.key_manager]
service_url = "https://{{ $cpSvc }}:9443/services/"
username = "$ref{super_admin.username}"
password = "$ref{super_admin.password}"

[apim.throttling]
service_url = "https://{{ $tmSvc }}:9443/services/"
throttle_decision_endpoints = ["tcp://localhost:5672"]
{{- if gt (int $tm.replicas) 1 }}
# Los demás nodos del Traffic Manager (lo completa el contenedor de inicio, sin el propio nodo).
event_duplicate_url = [@@PARES_EVENTOS@@]
{{- end }}

[apim.event_hub]
enable = true
username = "$ref{super_admin.username}"
password = "$ref{super_admin.password}"
service_url = "https://{{ $cpSvc }}:9443/services/"
event_listening_endpoints = [{{ include "nexo.listaPares" (dict "ctx" . "comp" "apim-cp" "replicas" $cp.replicas "esquema" "tcp" "puerto" 5672) }}]

[apim.oauth_config]
revoke_endpoint = "https://{{ $cpSvc }}:9443/oauth2/revoke"
{{ include "nexo.toml.otel" (dict "ctx" .) }}

[database.local]
url = "jdbc:h2:./repository/database/WSO2CARBON_DB;DB_CLOSE_ON_EXIT=FALSE"
{{- end -}}

{{/* ------------------------------------------------------------------ Universal Gateway. Recibe ctx, clave, gw. */}}
{{- define "nexo.toml.gw" -}}
{{- $ctx := .ctx -}}
{{- $gw := .gw -}}
{{- $cp := $ctx.Values.apim.controlPlane -}}
{{- $tm := $ctx.Values.apim.trafficManager -}}
{{- $cpSvc := include "nexo.dns" (dict "ctx" $ctx "comp" "apim-cp") -}}
{{- $tmSvc := include "nexo.dns" (dict "ctx" $ctx "comp" "apim-tm") -}}
{{- $etiquetas := list -}}
{{- range $gw.ambientes }}{{ $etiquetas = append $etiquetas .nombre }}{{ end -}}
# Yago Nexo · WSO2 Universal Gateway 4.7.0 · audiencia "{{ .clave }}".
# Solo recibe las APIs desplegadas en sus ambientes ({{ join ", " $etiquetas }}); las de otras audiencias no
# existen en este nodo. Generado por el chart nexo-platform; no editar en el pod.

[server]
hostname = {{ (first $gw.ambientes).vhost | quote }}
node_ip = "$env{NODE_IP}"
server_role = "default"

{{ include "nexo.toml.comun" (dict "ctx" $ctx) }}

[apim.key_manager]
service_url = "https://{{ $cpSvc }}:9443/services/"
username = "$ref{super_admin.username}"
password = "$ref{super_admin.password}"

[apim.event_hub]
enable = true
username = "$ref{super_admin.username}"
password = "$ref{super_admin.password}"
service_url = "https://{{ $cpSvc }}:9443/services/"
event_listening_endpoints = [{{ include "nexo.listaPares" (dict "ctx" $ctx "comp" "apim-cp" "replicas" $cp.replicas "esquema" "tcp" "puerto" 5672) }}]

[apim.sync_runtime_artifacts.gateway]
gateway_labels = {{ toJson $etiquetas }}

[apim.throttling]
username = "$ref{super_admin.username}"
password = "$ref{super_admin.password}"
service_url = "https://{{ $tmSvc }}:9443/services/"
throttle_decision_endpoints = [{{ include "nexo.listaPares" (dict "ctx" $ctx "comp" "apim-tm" "replicas" $tm.replicas "esquema" "tcp" "puerto" 5672) }}]
{{- range $i := until (int $tm.replicas) }}

# Cada Traffic Manager recibe todos los eventos (un grupo por nodo).
[[apim.throttling.url_group]]
traffic_manager_urls = ["tcp://{{ include "nexo.dnsPar" (dict "ctx" $ctx "comp" "apim-tm" "i" $i) }}:9611"]
traffic_manager_auth_urls = ["ssl://{{ include "nexo.dnsPar" (dict "ctx" $ctx "comp" "apim-tm" "i" $i) }}:9711"]
type = "loadbalance"
{{- end }}

[apim.analytics]
enable = true
type = "elk"
{{ include "nexo.toml.otel" (dict "ctx" $ctx) }}

[apim.cache.gateway_token]
enable = true
expiry_time = {{ $gw.cache.tokenMinutos }}

[apim.cache.resource]
enable = true

[apim.cache.jwt_claim]
enable = true
expiry_time = {{ $gw.cache.claimsSegundos }}

[apim.oauth_config]
remove_outbound_auth_header = true
auth_header = "Authorization"

[apim.cors]
allow_origins = "*"
allow_methods = {{ toJson $gw.cors.metodos }}
allow_headers = {{ toJson $gw.cors.encabezados }}
allow_credentials = false
{{- end -}}
