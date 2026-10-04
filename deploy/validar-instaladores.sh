#!/usr/bin/env bash
# Yago Nexo · validación de los instaladores, sin clúster ni nube.
#
#   deploy/validar-instaladores.sh             valida el chart, el playbook y el módulo de OpenTofu
#   deploy/validar-instaladores.sh --instalar  antes instala en ~/.local/bin las herramientas que falten
#
# Qué revisa:
#   1. Helm:     helm lint --strict con cada archivo de valores, y helm template | kubeconform -strict.
#                Los recursos de Kubernetes deben tener esquema; las CRD (ServiceMonitor, CloudNativePG,
#                Traefik, GKE) se validan con el catálogo de esquemas de CRD y solo se omiten si falta el suyo.
#   2. Ansible:  ansible-playbook --syntax-check y ansible-lint (perfil production) si está instalado.
#   3. OpenTofu: tofu fmt -check, tofu init -backend=false, tofu validate y tofu test (proveedor simulado).
#
# Las herramientas se descargan de sus publicaciones oficiales por HTTPS y se verifican con su SHA-256.
set -uo pipefail

RAIZ=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHART="$RAIZ/deploy/helm/nexo-platform"
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

if [ "${1:-}" = "--instalar" ]; then
  titulo "Instalación de herramientas en $BIN"
  mkdir -p "$BIN"
  command -v helm >/dev/null || paso "instalar Helm $HELM_VERSION" instalar_helm
  command -v kubeconform >/dev/null || paso "instalar kubeconform $KUBECONFORM_VERSION" instalar_kubeconform
  command -v tofu >/dev/null || paso "instalar OpenTofu $TOFU_VERSION" instalar_tofu
  { command -v ansible-playbook >/dev/null && command -v ansible-lint >/dev/null; } || paso "instalar ansible-core y ansible-lint" instalar_ansible
  cd "$RAIZ" || exit 1
fi

faltan=()
for h in helm kubeconform ansible-playbook ansible-galaxy tofu python3; do
  command -v "$h" >/dev/null || faltan+=("$h")
done
if [ ${#faltan[@]} -gt 0 ]; then
  echo "Faltan herramientas: ${faltan[*]}. Ejecute: deploy/validar-instaladores.sh --instalar" >&2
  exit 2
fi

titulo "Versiones"
helm version --short
kubeconform -v
tofu version | head -1
ansible-playbook --version | head -1
command -v ansible-lint >/dev/null && ansible-lint --version | head -1

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

validar_render() {
  # validar_render <nombre> [argumentos de helm template...]
  local nombre="$1"
  shift
  local r="$TMP/$nombre"
  helm template nexo-platform "$CHART" --namespace nexo "$@" >"$r.yaml" || return 1
  separar "$r.yaml" "$r.k8s.yaml" "$r.crd.yaml" || return 1
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
