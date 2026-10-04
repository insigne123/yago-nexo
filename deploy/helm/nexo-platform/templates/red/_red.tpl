{{/* Piezas de las políticas de red. */}}

{{/* Origen o destino: pods de un componente de este release. Recibe ctx y comp. */}}
{{- define "nexo.np.comp" -}}
- podSelector:
    matchLabels:
      {{- include "nexo.selector" . | nindent 6 }}
{{- end -}}

{{/* Origen o destino: todos los gateways de este release. */}}
{{- define "nexo.np.gateways" -}}
- podSelector:
    matchLabels:
      app.kubernetes.io/instance: {{ .ctx.Release.Name }}
      nexo.yago.cl/rol: gateway
{{- end -}}

{{/* Lista de puertos TCP. Recibe puertos (lista de números). */}}
{{- define "nexo.np.puertos" -}}
ports:
  {{- range .puertos }}
  - protocol: TCP
    port: {{ . }}
  {{- end }}
{{- end -}}

{{/*
Regla de salida hacia una dependencia externa. Recibe red (lista de NetworkPolicyPeer) y puertos.
Si "red" está vacía, permite cualquier destino, pero solo en esos puertos.
*/}}
{{- define "nexo.np.salidaDep" -}}
{{- if .red -}}
- to:
    {{- toYaml .red | nindent 4 }}
  {{- include "nexo.np.puertos" . | nindent 2 }}
{{- else -}}
- {{ include "nexo.np.puertos" . | nindent 2 | trim }}
{{- end -}}
{{- end -}}

{{/* Encabezado de una política para un componente. Recibe ctx, comp y nombre (sufijo opcional). */}}
{{- define "nexo.np.encabezado" -}}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "nexo.nombre" (dict "ctx" .ctx "comp" (printf "red-%s" .comp)) }}
  labels:
    {{- include "nexo.etiquetas" (dict "ctx" .ctx "comp" (printf "red-%s" .comp)) | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      {{- include "nexo.selector" . | nindent 6 }}
  policyTypes: [Ingress, Egress]
{{- end -}}
