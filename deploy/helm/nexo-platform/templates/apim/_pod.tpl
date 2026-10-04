{{/* Piezas comunes de los pods de WSO2 API Manager. */}}

{{/* Variables de entorno de los nodos de API Manager. Recibe ctx y bd (true si usa apim_db/shared_db). */}}
{{- define "nexo.apim.env" -}}
{{- $s := .ctx.Values.secretos -}}
{{ include "nexo.envWso2" . }}
{{ include "nexo.envSecreto" (dict "nombre" "APIM_ADMIN_PASSWORD" "secreto" $s.apim.existingSecret "clave" $s.apim.claves.adminPassword) }}
{{ include "nexo.envSecreto" (dict "nombre" "APIM_ENCRYPTION_KEY" "secreto" $s.apim.existingSecret "clave" $s.apim.claves.encryptionKey) }}
{{- if .bd }}
{{ include "nexo.envSecreto" (dict "nombre" "APIM_DB_PASSWORD" "secreto" $s.apimBd.existingSecret "clave" $s.apimBd.claves.password) }}
{{- end }}
{{- if $s.almacenLlaves.existingSecret }}
{{ include "nexo.envSecreto" (dict "nombre" "WSO2_KEYSTORE_PASSWORD" "secreto" $s.almacenLlaves.existingSecret "clave" $s.almacenLlaves.claves.password) }}
{{- end }}
{{- end -}}

{{/* Montajes de los almacenes de llaves y de la CA de PostgreSQL. Recibe ctx y base (carpeta de seguridad). */}}
{{- define "nexo.apim.montajesSeguridad" -}}
{{- $ks := .ctx.Values.secretos.almacenLlaves -}}
{{- if $ks.existingSecret }}
- name: almacen-llaves
  mountPath: {{ .base }}/{{ $ks.archivos.keystore }}
  subPath: {{ $ks.archivos.keystore }}
  readOnly: true
- name: almacen-llaves
  mountPath: {{ .base }}/{{ $ks.archivos.truststore }}
  subPath: {{ $ks.archivos.truststore }}
  readOnly: true
{{- end }}
{{- if and (eq .ctx.Values.global.dependencias.postgresql.ssl "verificado") .ctx.Values.global.tlsInterno.caSecret }}
- name: ca-interna
  mountPath: /home/wso2carbon/nexo-ca
  readOnly: true
{{- end }}
{{- end -}}

{{- define "nexo.apim.volumenesSeguridad" -}}
{{- $ks := .ctx.Values.secretos.almacenLlaves -}}
{{- if $ks.existingSecret }}
- name: almacen-llaves
  secret:
    secretName: {{ $ks.existingSecret }}
{{- end }}
{{- if .ctx.Values.global.tlsInterno.caSecret }}
- name: ca-interna
  secret:
    secretName: {{ .ctx.Values.global.tlsInterno.caSecret }}
{{- end }}
{{- end -}}

{{/* Contenedor de inicio que deja el deployment.toml final con los otros nodos. Recibe ctx, comp, cfg, imagen. */}}
{{- define "nexo.apim.initConfig" -}}
- name: configuracion
  image: {{ .imagen }}
  imagePullPolicy: {{ .ctx.Values.global.imagePullPolicy }}
  command: ["/bin/sh", "/scripts/preparar-config.sh"]
  env:
    - name: NEXO_REPLICAS
      value: {{ .cfg.replicas | quote }}
    - name: NEXO_STS
      value: {{ include "nexo.nombre" . }}
    - name: NEXO_HEADLESS
      value: {{ printf "%s-pares.%s.svc" (include "nexo.nombre" .) .ctx.Release.Namespace }}
  securityContext:
    {{- include "nexo.contenedorSeguridad" (dict "soloLectura" true) | nindent 4 }}
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 128Mi
  volumeMounts:
    - name: plantilla
      mountPath: /plantilla
      readOnly: true
    - name: scripts
      mountPath: /scripts
      readOnly: true
    - name: config
      mountPath: /config
{{- end -}}

{{/* Fluent Bit junto al nodo. Recibe ctx y rol (cp | gw). */}}
{{- define "nexo.apim.sidecarRegistros" -}}
{{- $r := .ctx.Values.apim.registros -}}
{{- $s := .ctx.Values.secretos.opensearch -}}
- name: registros
  image: {{ include "nexo.imagen" (dict "ctx" .ctx "img" $r.image) }}
  imagePullPolicy: {{ .ctx.Values.global.imagePullPolicy }}
  args: ["/fluent-bit/bin/fluent-bit", "-c", "/fluent-bit/etc/nexo/fluent-bit.yaml"]
  env:
    - name: POD_NAME
      valueFrom:
        fieldRef:
          fieldPath: metadata.name
    {{- if $s.existingSecret }}
    {{- include "nexo.envSecreto" (dict "nombre" "OPENSEARCH_USER" "secreto" $s.existingSecret "clave" $s.claves.usuario) | nindent 4 }}
    {{- include "nexo.envSecreto" (dict "nombre" "OPENSEARCH_PASSWORD" "secreto" $s.existingSecret "clave" $s.claves.password) | nindent 4 }}
    {{- end }}
  ports:
    - name: fb-http
      containerPort: 2020
    {{- if eq .rol "gw" }}
    - name: fb-metricas
      containerPort: 2021
    {{- end }}
  livenessProbe:
    tcpSocket:
      port: 2020
    periodSeconds: 30
  securityContext:
    {{- include "nexo.contenedorSeguridad" (dict "soloLectura" true) | nindent 4 }}
  resources:
    {{- toYaml $r.resources | nindent 4 }}
  volumeMounts:
    - name: registros
      mountPath: /wso2/logs
      readOnly: true
    - name: almacen-registros
      mountPath: /var/fluent-bit/storage
    - name: config-registros
      mountPath: /fluent-bit/etc/nexo
      readOnly: true
{{- end -}}

{{- define "nexo.apim.volumenesRegistros" -}}
- name: registros
  emptyDir:
    sizeLimit: 2Gi
- name: almacen-registros
  emptyDir:
    sizeLimit: 1Gi
- name: config-registros
  configMap:
    name: {{ include "nexo.nombre" (dict "ctx" .ctx "comp" (printf "registros-%s" .rol)) }}
{{- end -}}

{{/* preStop: deja de recibir tráfico antes de que llegue SIGTERM. */}}
{{- define "nexo.preStop" -}}
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep {{ default 10 .segundos }}"]
{{- end -}}
