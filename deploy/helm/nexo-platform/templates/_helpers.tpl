{{/*
Yago Nexo · plantillas comunes del chart nexo-platform.
Convención: las plantillas reciben un dict con "ctx" (el contexto raíz $) y, según el caso, "comp" (nombre
del componente, por ejemplo "apim-cp") y "cfg" (los valores del componente).
*/}}

{{/* Prefijo de los recursos: nombreBase o, si está vacío, el nombre del release. */}}
{{- define "nexo.base" -}}
{{- default .Release.Name .Values.nombreBase | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{/* Nombre de un recurso del componente: <base>-<comp>. */}}
{{- define "nexo.nombre" -}}
{{- printf "%s-%s" (include "nexo.base" .ctx) .comp | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Nombre DNS de un servicio dentro del clúster: <servicio>.<namespace>.svc */}}
{{- define "nexo.dns" -}}
{{- printf "%s.%s.svc" (include "nexo.nombre" .) .ctx.Release.Namespace -}}
{{- end -}}

{{/* Nombre DNS de la réplica i de un StatefulSet: <sts>-<i>.<headless>.<namespace>.svc */}}
{{- define "nexo.dnsPar" -}}
{{- $sts := include "nexo.nombre" . -}}
{{- printf "%s-%d.%s-pares.%s.svc" $sts (int .i) $sts .ctx.Release.Namespace -}}
{{- end -}}

{{- define "nexo.selector" -}}
app.kubernetes.io/name: {{ .comp }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
{{- end -}}

{{- define "nexo.etiquetas" -}}
{{ include "nexo.selector" . }}
app.kubernetes.io/part-of: nexo-platform
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
app.kubernetes.io/version: {{ .ctx.Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version | replace "+" "_" }}
nexo.yago.cl/ambiente: {{ .ctx.Values.global.ambiente }}
nexo.yago.cl/sitio: {{ .ctx.Values.global.sitio }}
{{- with .rol }}
nexo.yago.cl/rol: {{ . }}
{{- end }}
{{- end -}}

{{/* Imagen: <registro>/<repositorio>:<etiqueta>; la etiqueta vacía toma la appVersion del chart. */}}
{{- define "nexo.imagen" -}}
{{- $reg := default .ctx.Values.global.imageRegistry .img.registry -}}
{{- $tag := default .ctx.Chart.AppVersion .img.tag -}}
{{- if .img.digest -}}
{{- if $reg }}{{ printf "%s/%s@%s" $reg .img.repository .img.digest }}{{ else }}{{ printf "%s@%s" .img.repository .img.digest }}{{ end -}}
{{- else -}}
{{- if $reg }}{{ printf "%s/%s:%s" $reg .img.repository $tag }}{{ else }}{{ printf "%s:%s" .img.repository $tag }}{{ end -}}
{{- end -}}
{{- end -}}

{{/* Contexto de seguridad del pod (compatible con Pod Security "restricted"). */}}
{{- define "nexo.podSeguridad" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .uid }}
fsGroup: {{ .uid }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "nexo.contenedorSeguridad" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: {{ default false .soloLectura }}
capabilities:
  drop: [ALL]
{{- end -}}

{{/*
Campos comunes del pod: cuenta de servicio, imágenes, afinidad, nodos, tolerancias y prioridad.
Recibe ctx, comp y cfg.
*/}}
{{- define "nexo.podComun" -}}
serviceAccountName: {{ include "nexo.nombre" . }}
automountServiceAccountToken: false
{{- with .ctx.Values.global.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .ctx.Values.global.priorityClassName }}
priorityClassName: {{ . }}
{{- end }}
{{- $ns := merge (dict) (default (dict) .cfg.nodeSelector) .ctx.Values.global.nodeSelector }}
{{- with $ns }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- $tol := concat (default (list) .cfg.tolerations) .ctx.Values.global.tolerations }}
{{- with $tol }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
affinity:
  podAntiAffinity:
    {{- if eq .ctx.Values.global.antiAfinidad "requerida" }}
    requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
            {{- include "nexo.selector" . | nindent 12 }}
    {{- else }}
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          topologyKey: kubernetes.io/hostname
          labelSelector:
            matchLabels:
              {{- include "nexo.selector" . | nindent 14 }}
    {{- end }}
{{- if .ctx.Values.global.distribuirPorZona }}
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "nexo.selector" . | nindent 8 }}
{{- end }}
{{- end -}}

{{/* Variable de entorno leída de un Secret. Recibe nombre, secreto y clave. */}}
{{- define "nexo.envSecreto" -}}
- name: {{ .nombre }}
  valueFrom:
    secretKeyRef:
      name: {{ required (printf "falta el nombre del Secret para %s" .nombre) .secreto }}
      key: {{ .clave }}
{{- end -}}

{{/* Variables comunes de los procesos Java de WSO2. */}}
{{- define "nexo.envWso2" -}}
- name: NODE_IP
  valueFrom:
    fieldRef:
      fieldPath: status.podIP
- name: POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: TZ
  value: {{ .ctx.Values.global.zonaHoraria | quote }}
{{- end -}}

{{/* Sondas de los servidores WSO2 (Carbon). Recibe cfg (con "sondas") y, opcional, "lista" (ruta de lista). */}}
{{- define "nexo.sondasWso2" -}}
startupProbe:
  tcpSocket:
    port: 9443
  periodSeconds: {{ .cfg.sondas.inicio.periodSeconds }}
  failureThreshold: {{ .cfg.sondas.inicio.failureThreshold }}
livenessProbe:
  httpGet:
    path: /services/Version
    port: 9763
  periodSeconds: {{ .cfg.sondas.vida.periodSeconds }}
  timeoutSeconds: {{ .cfg.sondas.vida.timeoutSeconds }}
  failureThreshold: {{ .cfg.sondas.vida.failureThreshold }}
readinessProbe:
  {{- if .listaGateway }}
  httpGet:
    path: /api/am/gateway/v2/server-startup-healthcheck
    port: 9443
    scheme: HTTPS
  {{- else }}
  httpGet:
    path: /services/Version
    port: 9763
  {{- end }}
  periodSeconds: {{ .cfg.sondas.lista.periodSeconds }}
  timeoutSeconds: {{ .cfg.sondas.lista.timeoutSeconds }}
  failureThreshold: {{ .cfg.sondas.lista.failureThreshold }}
{{- end -}}

{{/* JVM_MEM_OPTS de WSO2: memoria y, si corresponde, el agente JMX (solo lo usa la JVM principal). */}}
{{- define "nexo.jvm" -}}
{{- $partes := list .cfg.jvm "-XX:+ExitOnOutOfMemoryError" -}}
{{- if and .jmx .ctx.Values.apim.metricasJmx.enabled -}}
{{- $partes = append $partes .ctx.Values.apim.metricasJmx.agente -}}
{{- end -}}
{{- join " " $partes -}}
{{- end -}}

{{/* ------------------------------------------------------------------ PostgreSQL */}}

{{- define "nexo.pg.host" -}}
{{- if and .Values.postgresql.cloudnativepg.enabled (not .Values.global.dependencias.postgresql.host) -}}
{{- printf "%s-rw.%s.svc" (include "nexo.nombre" (dict "ctx" . "comp" "bd")) .Release.Namespace -}}
{{- else -}}
{{- required "global.dependencias.postgresql.host es obligatorio" .Values.global.dependencias.postgresql.host -}}
{{- end -}}
{{- end -}}

{{/* URL JDBC de una base (recibe ctx y base). */}}
{{- define "nexo.pg.jdbc" -}}
{{- $pg := .ctx.Values.global.dependencias.postgresql -}}
{{- $modo := dict "deshabilitado" "disable" "requerido" "require" "verificado" "verify-full" -}}
{{- $url := printf "jdbc:postgresql://%s:%d/%s?sslmode=%s" (include "nexo.pg.host" .ctx) (int $pg.puerto) .base (get $modo $pg.ssl) -}}
{{- if eq $pg.ssl "verificado" -}}
{{- $url = printf "%s&sslrootcert=/home/wso2carbon/nexo-ca/%s" $url .ctx.Values.global.tlsInterno.caClave -}}
{{- end -}}
{{- $url -}}
{{- end -}}

{{/* URL postgres:// para los servicios Node (la contraseña llega por $(VAR) desde un Secret). */}}
{{- define "nexo.pg.url" -}}
{{- $pg := .ctx.Values.global.dependencias.postgresql -}}
{{- printf "postgres://%s:$(%s)@%s:%d/%s" .usuario .variable (include "nexo.pg.host" .ctx) (int $pg.puerto) .base -}}
{{- end -}}

{{/* Variables de TLS de PostgreSQL para los servicios Node. */}}
{{- define "nexo.pg.envNode" -}}
{{- $pg := .Values.global.dependencias.postgresql }}
- name: NEXO_DATABASE_SSL
  value: {{ ne $pg.ssl "deshabilitado" | quote }}
- name: NEXO_DATABASE_SSL_INSECURE
  value: {{ eq $pg.ssl "requerido" | quote }}
{{- end -}}

{{/* CA interna para los servicios Node (NODE_EXTRA_CA_CERTS) y el modo inseguro de TLS hacia WSO2. */}}
{{- define "nexo.tls.envNode" -}}
- name: NEXO_WSO2_INSECURE_TLS
  value: {{ .Values.global.tlsInterno.inseguro | quote }}
{{- if .Values.global.tlsInterno.caSecret }}
- name: NODE_EXTRA_CA_CERTS
  value: /etc/nexo/ca/{{ .Values.global.tlsInterno.caClave }}
{{- end }}
{{- end -}}

{{- define "nexo.tls.volumen" -}}
{{- if .Values.global.tlsInterno.caSecret }}
- name: ca-interna
  secret:
    secretName: {{ .Values.global.tlsInterno.caSecret }}
{{- end }}
{{- end -}}

{{- define "nexo.tls.montaje" -}}
{{- if .Values.global.tlsInterno.caSecret }}
- name: ca-interna
  mountPath: /etc/nexo/ca
  readOnly: true
{{- end }}
{{- end -}}

{{/* ------------------------------------------------------------------ WSO2: nombres y listas */}}

{{/* Lista TOML de los nodos de un StatefulSet en un puerto: "tcp://a:5672", "tcp://b:5672" */}}
{{- define "nexo.listaPares" -}}
{{- $l := list -}}
{{- range $i := until (int .replicas) -}}
{{- $l = append $l (printf "\"%s://%s:%d\"" $.esquema (include "nexo.dnsPar" (dict "ctx" $.ctx "comp" $.comp "i" $i)) (int $.puerto)) -}}
{{- end -}}
{{- join ", " $l -}}
{{- end -}}

{{/* Gateways habilitados, en orden alfabético estable: lista de dicts {clave, cfg}. */}}
{{- define "nexo.gateways" -}}
{{- $out := list -}}
{{- range $clave := keys .Values.apim.gateways | sortAlpha -}}
{{- $gw := get $.Values.apim.gateways $clave -}}
{{- if $gw.enabled -}}
{{- $out = append $out $clave -}}
{{- end -}}
{{- end -}}
{{- join "," $out -}}
{{- end -}}

{{/* Ambientes de gateway "Nombre:vhost" separados por coma (Consola y motores). El primero es el principal. */}}
{{- define "nexo.ambientesGateway" -}}
{{- $l := list -}}
{{- range $clave := splitList "," (include "nexo.gateways" .) -}}
{{- if $clave -}}
{{- $gw := get $.Values.apim.gateways $clave -}}
{{- range $amb := $gw.ambientes -}}
{{- $l = append $l (printf "%s:%s" $amb.nombre $amb.vhost) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- join "," $l -}}
{{- end -}}

{{/* Valores efectivos de un gateway: gatewayComun mezclado con los del gateway. Devuelve YAML. */}}
{{- define "nexo.gatewayCfg" -}}
{{- $gw := get .ctx.Values.apim.gateways .clave -}}
{{- toYaml (mergeOverwrite (deepCopy .ctx.Values.apim.gatewayComun) (deepCopy $gw)) -}}
{{- end -}}

{{/* Anotaciones del Service de un backend HTTPS según el proveedor de Ingress. */}}
{{- define "nexo.anotacionesServicioHttps" -}}
{{- $ing := .ctx.Values.global.ingress -}}
{{- $a := dict -}}
{{- if eq $ing.proveedor "traefik" -}}
{{- $_ := set $a "traefik.ingress.kubernetes.io/service.serversscheme" "https" -}}
{{- if $ing.traefik.serversTransport.crear -}}
{{- $_ := set $a "traefik.ingress.kubernetes.io/service.serverstransport" (printf "%s-%s@kubernetescrd" .ctx.Release.Namespace (include "nexo.nombre" (dict "ctx" .ctx "comp" $ing.traefik.serversTransport.nombre))) -}}
{{- end -}}
{{- if .sticky -}}
{{- $_ := set $a "traefik.ingress.kubernetes.io/service.sticky.cookie" "true" -}}
{{- $_ := set $a "traefik.ingress.kubernetes.io/service.sticky.cookie.secure" "true" -}}
{{- $_ := set $a "traefik.ingress.kubernetes.io/service.sticky.cookie.httponly" "true" -}}
{{- end -}}
{{- else if eq $ing.proveedor "gce" -}}
{{- $protocolos := dict -}}
{{- range .puertos }}{{ $_ := set $protocolos . "HTTPS" }}{{ end -}}
{{- $_ := set $a "cloud.google.com/app-protocols" (toJson $protocolos) -}}
{{- $_ := set $a "cloud.google.com/neg" "{\"ingress\": true}" -}}
{{- if .backendConfig -}}
{{- $_ := set $a "cloud.google.com/backend-config" (printf "{\"default\": \"%s\"}" .backendConfig) -}}
{{- end -}}
{{- end -}}
{{- $a = merge $a (default (dict) .extra) -}}
{{- if $a }}
annotations:
  {{- toYaml $a | nindent 2 }}
{{- end }}
{{- end -}}

{{/* Bloque TLS de un Ingress. Recibe ctx, hosts y secret (opcional). */}}
{{- define "nexo.ingressTls" -}}
{{- $secret := default .ctx.Values.global.ingress.tlsSecret .secret -}}
{{- if $secret }}
tls:
  - secretName: {{ $secret }}
    hosts:
      {{- toYaml .hosts | nindent 6 }}
{{- end }}
{{- end -}}

{{/* Anotaciones del Ingress: las globales más las del componente. */}}
{{- define "nexo.ingressAnotaciones" -}}
{{- $a := merge (dict) (default (dict) .extra) .ctx.Values.global.ingress.annotations -}}
{{- if $a }}
annotations:
  {{- toYaml $a | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
Incluye una plantilla que puede quedar vacía sin dejar líneas en blanco: recibe plantilla (nombre), datos
(contexto de la plantilla) e indent (sangría).
*/}}
{{- define "nexo.incluir" -}}
{{- with (include .plantilla .datos | trim) }}{{ . | nindent (int $.indent) }}{{ end -}}
{{- end -}}
