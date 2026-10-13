#!/usr/bin/env bash
# Yago Nexo · validación de los instaladores, sin clúster ni nube.
#
#   deploy/validar-instaladores.sh             valida el chart, el playbook y el módulo de OpenTofu
#   deploy/validar-instaladores.sh --instalar  antes instala en ~/.local/bin las herramientas que falten
#                                              (y Helm si la versión instalada no es la fijada)
#   deploy/validar-instaladores.sh --solo-helm solo el chart (lo usa el job «Instaladores» del CI)
#
# Qué revisa:
#   1. Helm:     helm lint --strict con cada archivo de valores, y helm template | kubeconform -strict;
#                además, que cada deployment.toml generado sea TOML válido y que el render cumpla las reglas
#                de seguridad del chart (raíz de solo lectura en todos los contenedores, sin usuario root y
#                ningún deployment.toml en un ConfigMap: van en Secrets porque nombran contraseñas).
#                Los recursos de Kubernetes deben tener esquema; las CRD (ServiceMonitor, CloudNativePG,
#                Traefik, GKE) se validan con el catálogo de esquemas de CRD y solo se omiten si falta el suyo.
#   2. Ansible:  ansible-playbook --syntax-check y ansible-lint (perfil production) si está instalado.
#   3. OpenTofu: tofu fmt -check, tofu init -backend=false, tofu validate y tofu test (proveedor simulado).
#
# Las herramientas se descargan de sus publicaciones oficiales por HTTPS y se verifican con su SHA-256.
set -uo pipefail

RAIZ=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHART="$RAIZ/deploy/helm/nexo-platform"
LUA_COMPOSE="$RAIZ/deploy/compose/fluent-bit/enmascarar.lua"
ANSIBLE_DIR="$RAIZ/deploy/ansible/rke2"
TOFU_DIR="$RAIZ/deploy/opentofu/gcp-dr"
BIN="$HOME/.local/bin"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/nexo-instaladores"
export PATH="$BIN:$PATH"

# Versiones fijas: las mismas del instalador de Ansible y de la documentación.
HELM_VERSION=v4.3.0
KUBECONFORM_VERSION=v0.8.0
TOFU_VERSION=1.13.1
# Versión de Kubernetes de RKE2 v1.36.5+rke2r1 (esquemas de kubeconform).
K8S_VERSION=1.36.5
CATALOGO_CRD='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$CACHE/kubeconform" "$CACHE/tofu-plugins"

RESULTADOS=()
FALLAS=0

titulo() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
paso() {
  # paso "<descripción>" comando...: ejecuta, guarda el resultado y sigue aunque falle.
  local desc="$1"
  shift
  printf -- '-- %s\n' "$desc"
  if "$@"; then
    RESULTADOS+=("OK     $desc")
  else
    RESULTADOS+=("FALLA  $desc")
    FALLAS=$((FALLAS + 1))
  fi
}

# Algunos entornos dejan stdout/stderr en modo no bloqueante y Ansible se niega a correr así.
bloqueante() {
  python3 -c 'import os
for fd in (0, 1, 2):
    try:
        os.set_blocking(fd, True)
    except OSError:
        pass' 2>/dev/null || true
}

# ------------------------------------------------------------------ herramientas
descargar() { curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$2" "$1"; }

instalar_helm() {
  local d="$TMP/helm" a="helm-$HELM_VERSION-linux-amd64.tar.gz"
  mkdir -p "$d" && cd "$d" || return 1
  descargar "https://get.helm.sh/$a" "$a" && descargar "https://get.helm.sh/$a.sha256sum" "$a.sha256sum" &&
    sha256sum -c "$a.sha256sum" && tar xzf "$a" && install -m 0755 linux-amd64/helm "$BIN/helm"
}

instalar_kubeconform() {
  local d="$TMP/kubeconform" a=kubeconform-linux-amd64.tar.gz
  local base="https://github.com/yannh/kubeconform/releases/download/$KUBECONFORM_VERSION"
  mkdir -p "$d" && cd "$d" || return 1
  descargar "$base/$a" "$a" && descargar "$base/CHECKSUMS" CHECKSUMS &&
    grep " $a\$" CHECKSUMS | sha256sum -c - && tar xzf "$a" kubeconform && install -m 0755 kubeconform "$BIN/kubeconform"
}

instalar_tofu() {
  local d="$TMP/tofu" a="tofu_${TOFU_VERSION}_linux_amd64.zip"
  local base="https://github.com/opentofu/opentofu/releases/download/v$TOFU_VERSION"
  mkdir -p "$d" && cd "$d" || return 1
  descargar "$base/$a" "$a" && descargar "$base/tofu_${TOFU_VERSION}_SHA256SUMS" SHA256SUMS &&
    grep " $a\$" SHA256SUMS | sha256sum -c - &&
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extract('tofu', '.')" "$a" && install -m 0755 tofu "$BIN/tofu"
}

instalar_ansible() {
  python3 -m pip install --user --quiet "ansible-core>=2.16" ansible-lint
}

INSTALAR=0
SOLO_HELM=0
for arg in "$@"; do
  case "$arg" in
    --instalar) INSTALAR=1 ;;
    --solo-helm) SOLO_HELM=1 ;;
    *)
      echo "Opción desconocida: $arg (use --instalar y/o --solo-helm)" >&2
      exit 2
      ;;
  esac
done

if [ "$INSTALAR" = 1 ]; then
  titulo "Instalación de herramientas en $BIN"
  mkdir -p "$BIN"
  helm version --short 2>/dev/null | grep -q "^$HELM_VERSION+" || paso "instalar Helm $HELM_VERSION" instalar_helm
  command -v kubeconform >/dev/null || paso "instalar kubeconform $KUBECONFORM_VERSION" instalar_kubeconform
  if [ "$SOLO_HELM" = 0 ]; then
    command -v tofu >/dev/null || paso "instalar OpenTofu $TOFU_VERSION" instalar_tofu
    { command -v ansible-playbook >/dev/null && command -v ansible-lint >/dev/null; } || paso "instalar ansible-core y ansible-lint" instalar_ansible
  fi
  cd "$RAIZ" || exit 1
fi

necesarias=(helm kubeconform python3)
[ "$SOLO_HELM" = 0 ] && necesarias+=(ansible-playbook ansible-galaxy tofu)
faltan=()
for h in "${necesarias[@]}"; do
  command -v "$h" >/dev/null || faltan+=("$h")
done
if [ ${#faltan[@]} -gt 0 ]; then
  echo "Faltan herramientas: ${faltan[*]}. Ejecute: deploy/validar-instaladores.sh --instalar" >&2
  exit 2
fi

titulo "Versiones"
helm version --short
kubeconform -v
if [ "$SOLO_HELM" = 0 ]; then
  tofu version | head -1
  ansible-playbook --version | head -1
  command -v ansible-lint >/dev/null && ansible-lint --version | head -1
fi

# ------------------------------------------------------------------ 1. Helm
# Separa lo renderizado en recursos de Kubernetes y CRD (grupos que no son de Kubernetes).
separar() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys, yaml
origen, base, crd = sys.argv[1:4]
docs = [d for d in yaml.safe_load_all(open(origen, encoding="utf-8")) if d]
def es_crd(d):
    grupo = d.get("apiVersion", "").rpartition("/")[0]
    return "." in grupo and not grupo.endswith(".k8s.io")
for ruta, lista in ((base, [d for d in docs if not es_crd(d)]), (crd, [d for d in docs if es_crd(d)])):
    with open(ruta, "w", encoding="utf-8") as f:
        yaml.safe_dump_all(lista, f, allow_unicode=True, sort_keys=False)
print(f"{len(docs)} recursos: {sum(not es_crd(d) for d in docs)} de Kubernetes, {sum(es_crd(d) for d in docs)} CRD")
PY
}

# Revisa que cada deployment.toml generado sea TOML válido (sin tablas ni claves repetidas). Los deployment.toml
# van en Secrets (stringData).
validar_toml() {
  python3 - "$1" <<'PY'
import sys, yaml
try:
    import tomllib
except ModuleNotFoundError:
    print("Python sin tomllib (3.11 o superior): se omite la revisión de deployment.toml")
    sys.exit(0)
errores, n = 0, 0
for d in yaml.safe_load_all(open(sys.argv[1], encoding="utf-8")):
    if not d or d.get("kind") not in ("ConfigMap", "Secret"):
        continue
    for clave, texto in {**(d.get("data") or {}), **(d.get("stringData") or {})}.items():
        if not clave.endswith(".toml"):
            continue
        n += 1
        try:
            # La lista de los otros nodos la completa el contenedor de inicio.
            tomllib.loads(texto.replace("@@PARES_EVENTOS@@", '"tcp://nodo:5672"'))
        except tomllib.TOMLDecodeError as e:
            errores += 1
            print(f"{d['metadata']['name']}/{clave}: {e}")
print(f"{n} deployment.toml revisados, {errores} con errores")
sys.exit(1 if errores else 0)
PY
}

# Reglas de seguridad del render (las mismas que revisa Trivy en el CI, KSV-0014 y KSV-0109, más el usuario):
#   - cada contenedor e initContainer tiene securityContext.readOnlyRootFilesystem: true;
#   - cada pod corre sin root (runAsNonRoot en el pod o en el contenedor);
#   - ningún ConfigMap trae un deployment.toml (nombra contraseñas: va en un Secret).
validar_seguridad() {
  python3 - "$1" <<'PY'
import sys, yaml
errores, contenedores = [], 0
for d in yaml.safe_load_all(open(sys.argv[1], encoding="utf-8")):
    if not d:
        continue
    tipo, nombre = d.get("kind"), d.get("metadata", {}).get("name")
    if tipo == "ConfigMap" and any(k.endswith(".toml") for k in (d.get("data") or {})):
        errores.append(f"ConfigMap {nombre}: trae un deployment.toml (debe ir en un Secret)")
    spec = (d.get("spec") or {})
    if tipo == "CronJob":
        spec = spec.get("jobTemplate", {}).get("spec", {})
    pod = spec.get("template", {}).get("spec") if tipo in ("Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob") else None
    if not pod:
        continue
    pod_no_root = (pod.get("securityContext") or {}).get("runAsNonRoot") is True
    for c in (pod.get("initContainers") or []) + (pod.get("containers") or []):
        contenedores += 1
        sc = c.get("securityContext") or {}
        if sc.get("readOnlyRootFilesystem") is not True:
            errores.append(f"{tipo} {nombre}, contenedor {c['name']}: falta readOnlyRootFilesystem: true")
        if not (pod_no_root or sc.get("runAsNonRoot") is True):
            errores.append(f"{tipo} {nombre}, contenedor {c['name']}: puede correr como root (falta runAsNonRoot)")
for e in errores:
    print(e)
print(f"{contenedores} contenedores revisados, {len(errores)} incumplimientos de seguridad")
sys.exit(1 if errores else 0)
PY
}

# Enmascaramiento en el Fluent Bit del chart (BT-029), igual que en el laboratorio: cada ConfigMap de registros
# lleva enmascarar.lua idéntico a deploy/compose/fluent-bit/enmascarar.lua y un filtro lua que lo llama sobre la
# analítica y los logs de aplicación, antes de los filtros de métricas.
validar_enmascaramiento() {
  python3 - "$1" "$LUA_COMPOSE" <<'PY'
import sys, yaml
render, lua_compose = sys.argv[1:3]
esperado = open(lua_compose, encoding="utf-8").read()
errores, n = [], 0
for d in yaml.safe_load_all(open(render, encoding="utf-8")):
    if not d or d.get("kind") != "ConfigMap" or "fluent-bit.yaml" not in (d.get("data") or {}):
        continue
    n += 1
    nombre, data = d["metadata"]["name"], d["data"]
    if data.get("enmascarar.lua") != esperado:
        errores.append(f"ConfigMap {nombre}: enmascarar.lua falta o difiere de deploy/compose/fluent-bit/enmascarar.lua")
    filtros = (yaml.safe_load(data["fluent-bit.yaml"]).get("pipeline") or {}).get("filters") or []
    nombres = [f.get("name") for f in filtros]
    lua = [f for f in filtros if f.get("name") == "lua"]
    if not lua or lua[0].get("script") != "/fluent-bit/etc/nexo/enmascarar.lua" or lua[0].get("call") != "enmascarar":
        errores.append(f"ConfigMap {nombre}: falta el filtro lua que llama a enmascarar")
    elif lua[0].get("match_regex") != r"^apim\.(carbon|metrics)$":
        errores.append(f"ConfigMap {nombre}: el filtro lua no cubre apim.carbon y apim.metrics")
    elif "log_to_metrics" in nombres and nombres.index("lua") > nombres.index("log_to_metrics"):
        errores.append(f"ConfigMap {nombre}: el enmascaramiento debe ir antes de las métricas")
for e in errores:
    print(e)
print(f"{n} configuraciones de Fluent Bit revisadas, {len(errores)} sin enmascaramiento correcto")
sys.exit(1 if errores else 0)
PY
}

validar_render() {
  # validar_render <nombre> [argumentos de helm template...]
  local nombre="$1"
  shift
  local r="$TMP/$nombre"
  helm template nexo-platform "$CHART" --namespace nexo "$@" >"$r.yaml" || return 1
  separar "$r.yaml" "$r.k8s.yaml" "$r.crd.yaml" || return 1
  validar_toml "$r.yaml" || return 1
  validar_seguridad "$r.yaml" || return 1
  validar_enmascaramiento "$r.yaml" || return 1
  kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" -cache "$CACHE/kubeconform" \
    -schema-location default "$r.k8s.yaml" || return 1
  if [ -s "$r.crd.yaml" ] && [ "$(head -c 3 "$r.crd.yaml")" != "[]" ]; then
    kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" -cache "$CACHE/kubeconform" \
      -schema-location default -schema-location "$CATALOGO_CRD" -ignore-missing-schemas "$r.crd.yaml" || return 1
  fi
}

titulo "1. Helm: deploy/helm/nexo-platform"
for valores in values.yaml values-cpd.yaml values-gcp-dr.yaml values-qa.yaml values-dev.yaml; do
  args=()
  [ "$valores" != values.yaml ] && args=(-f "$CHART/$valores")
  paso "helm lint --strict ($valores)" helm lint "$CHART" --strict "${args[@]}"
  paso "helm template | kubeconform -strict ($valores)" validar_render "${valores%.yaml}" "${args[@]}"
done
# Opciones que ningún archivo de valores activa por omisión.
paso "helm template | kubeconform -strict (values-cpd.yaml + CloudNativePG)" \
  validar_render cpd-cloudnativepg -f "$CHART/values-cpd.yaml" \
  --set postgresql.cloudnativepg.enabled=true --set global.dependencias.postgresql.host=
paso "helm template | kubeconform -strict (values-gcp-dr.yaml + réplica CloudNativePG + Ingress de GKE)" \
  validar_render gcp-dr-replica-gce -f "$CHART/values-gcp-dr.yaml" \
  --set global.ingress.proveedor=gce --set global.ingress.className= \
  --set postgresql.cloudnativepg.enabled=true --set postgresql.cloudnativepg.replica.enabled=true \
  --set postgresql.cloudnativepg.replica.origen.host=10.50.0.20 \
  --set postgresql.cloudnativepg.replica.origen.certificadoSecret=nexo-bd-replica-cliente \
  --set postgresql.cloudnativepg.replica.origen.caSecret=nexo-bd-cpd-ca

if [ "$SOLO_HELM" = 1 ]; then
  titulo "Resumen (solo Helm)"
  printf '%s\n' "${RESULTADOS[@]}"
  if [ "$FALLAS" -gt 0 ]; then
    printf '\n%d validaciones fallaron.\n' "$FALLAS"
    exit 1
  fi
  printf '\nEl chart pasó todas las validaciones.\n'
  exit 0
fi

# ------------------------------------------------------------------ 2. Ansible
titulo "2. Ansible: deploy/ansible/rke2"
export ANSIBLE_COLLECTIONS_PATH="$CACHE/colecciones"
export ANSIBLE_CONFIG="$ANSIBLE_DIR/ansible.cfg"
cd "$ANSIBLE_DIR" || exit 1
bloqueante
paso "ansible-galaxy collection install -r requirements.yml" \
  ansible-galaxy collection install -r requirements.yml -p "$CACHE/colecciones"
bloqueante
paso "ansible-playbook --syntax-check site.yml" \
  ansible-playbook -i inventario/ejemplo/hosts.yml site.yml --syntax-check
if command -v ansible-lint >/dev/null; then
  bloqueante
  paso "ansible-lint (perfil production)" ansible-lint --offline
else
  echo "ansible-lint no está instalado: se omite (deploy/validar-instaladores.sh --instalar lo instala)."
  RESULTADOS+=("OMITE  ansible-lint (no instalado)")
fi
cd "$RAIZ" || exit 1

# ------------------------------------------------------------------ 3. OpenTofu
titulo "3. OpenTofu: deploy/opentofu/gcp-dr"
export TF_DATA_DIR="$TMP/tofu-datos" TF_PLUGIN_CACHE_DIR="$CACHE/tofu-plugins" TF_IN_AUTOMATION=1
paso "tofu fmt -check -recursive" tofu -chdir="$TOFU_DIR" fmt -check -recursive -diff
paso "tofu init -backend=false" tofu -chdir="$TOFU_DIR" init -backend=false -input=false -lockfile=readonly -no-color
paso "tofu validate" tofu -chdir="$TOFU_DIR" validate -no-color
paso "tofu test (proveedor simulado)" tofu -chdir="$TOFU_DIR" test -no-color

# ------------------------------------------------------------------ resumen
titulo "Resumen"
printf '%s\n' "${RESULTADOS[@]}"
if [ "$FALLAS" -gt 0 ]; then
  printf '\n%d validaciones fallaron.\n' "$FALLAS"
  exit 1
fi
printf '\nTodas las validaciones pasaron.\n'
