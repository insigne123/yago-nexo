# Instalador RKE2 para el CPD (Ansible)

Prepara las máquinas virtuales de VMware vSphere, instala Kubernetes RKE2 en versión fija (3 servidores y N
agentes), instala Helm y despliega la plataforma con `helm upgrade --install nexo-platform` y los valores del
CPD. Cada ejecución es idempotente: solo cambia lo que no está como se declaró.

Estado: **en desarrollo**. Pasa `ansible-playbook --syntax-check` y `ansible-lint` (perfil production), pero
todavía no se ejecuta contra máquinas reales.

## Qué hace

| Jugada | Hosts | Rol | Qué hace |
| --- | --- | --- | --- |
| Preparar | todos | `preparar_host` | Revisa sistema operativo admitido, CPU y memoria por grupo, nombre del nodo; apaga el intercambio; instala paquetes base; formatea (solo si está vacío) y monta el disco de datos en `/var/lib/rancher`; carga `overlay` y `br_netfilter`; fija sysctl (incluidos los del perfil CIS); configura chrony; abre los puertos de RKE2 en firewalld o ufw. |
| Servidores | `rke2_servidores`, de a uno | `rke2` | Instala RKE2 `rke2_version` (instalador oficial), crea el usuario `etcd` del perfil CIS, escribe `config.yaml` (CIS, Canal, Traefik, cifrado de Secrets, respaldos de etcd cada 6 horas, servidores sin cargas) y une cada servidor al primero. |
| Agentes | `rke2_agentes`, 30 % a la vez | `rke2` | Instala el agente y lo une al clúster; espera a que el nodo quede `Ready`. |
| Plataforma | primer servidor | `helm`, `nexo_plataforma` | Instala Helm `helm_version` verificando su SHA-256; crea el espacio de nombres con Pod Security `restricted`, los Secrets desde Ansible Vault, revisa que estén todos y ejecuta `helm upgrade --install` solo si cambió el chart, los valores o los Secrets. |

## Requisitos

- Máquina de control con Python 3.10 o superior, `ansible-core` 2.16 o superior y acceso SSH con `sudo` a los
  nodos.
- Máquinas virtuales con RHEL, Rocky o Alma 8/9, Ubuntu 22.04/24.04 o SLES 15, x86_64. Producción: 3
  servidores (4 vCPU y 16 GB como mínimo) y 11 agentes (8 vCPU y 32 GB), cada uno con un disco de datos
  (`/dev/sdb`) de al menos 100 GB, y `disk.EnableUUID = TRUE` en vSphere si se usa el CSI.
- Un nombre o VIP para los servidores (`rke2_direccion_registro`, puertos 6443 y 9345) y un balanceador para
  la entrada (puertos 80 y 443 de los agentes, donde corre Traefik).
- Acceso a `get.rke2.io`, `get.helm.sh` y al registro de imágenes, o los artefactos copiados en cada nodo
  (`rke2_ruta_artefactos`, instalación sin Internet).
- Los servicios externos de la plataforma (PostgreSQL, RabbitMQ, OpenSearch, Keycloak, Prometheus) y los
  Secrets que no son de texto (`nexo-wso2-almacen`, `nexo-tls`, `nexo-ca-interna`, `harbor-nexo`).

## Pasos

```bash
cd deploy/ansible/rke2

# 1. Colecciones de Ansible
ansible-galaxy collection install -r requirements.yml -p colecciones

# 2. Inventario del sitio (copie el de ejemplo y ajuste nombres, IP, discos y NTP)
cp -r inventario/ejemplo inventario/cpd
cp inventario/cpd/group_vars/all/vault.yml.ejemplo inventario/cpd/group_vars/all/vault.yml
ansible-vault encrypt inventario/cpd/group_vars/all/vault.yml   # complete antes los valores
cp inventario/cpd/valores-sitio.yaml.ejemplo inventario/cpd/valores-sitio.yaml

# 3. Revisión sin cambios
ansible-playbook -i inventario/cpd/hosts.yml site.yml --syntax-check
ansible -i inventario/cpd/hosts.yml rke2_cluster -m ansible.builtin.ping

# 4. Instalación completa (o por etapas con --tags preparar | rke2 | helm | plataforma)
ansible-playbook -i inventario/cpd/hosts.yml site.yml --ask-vault-pass
```

La primera ejecución de `--tags plataforma` crea el espacio de nombres `nexo` y se detiene si falta algún
Secret de `nexo_plataforma_secretos_requeridos`, con la lista de los que faltan. Los de texto los crea el
playbook desde `vault.yml`; los binarios se crean una vez desde el primer servidor (o con External Secrets):

```bash
export KUBECONFIG=/etc/rancher/rke2/rke2.yaml
kubectl -n nexo create secret generic nexo-wso2-almacen \
  --from-file=wso2carbon.jks --from-file=client-truststore.jks --from-literal=keystore-password='<contraseña>'
kubectl -n nexo create secret tls nexo-tls --cert=nexo.crt --key=nexo.key
kubectl -n nexo create secret generic nexo-ca-interna --from-file=ca.crt
kubectl -n nexo create secret docker-registry harbor-nexo --docker-server=harbor.nexo.example \
  --docker-username='<usuario>' --docker-password='<contraseña>'
```

## Verificación

```bash
# Desde el primer servidor
export KUBECONFIG=/etc/rancher/rke2/rke2.yaml PATH=$PATH:/var/lib/rancher/rke2/bin
kubectl get nodes -o wide                      # 14 nodos Ready, misma versión
kubectl -n nexo get pods,pdb,hpa,networkpolicy
helm -n nexo status nexo-platform
```

Volver a ejecutar el playbook debe terminar con `changed=0` en todos los hosts.

## Actualizar y volver atrás

- **Plataforma:** cambie la etiqueta de las imágenes o los valores y vuelva a ejecutar `--tags plataforma`.
  Para volver a la versión anterior: `helm -n nexo history nexo-platform` y
  `helm -n nexo rollback nexo-platform <revisión> --wait`.
- **RKE2:** cambie `rke2_version` y ejecute `--tags rke2` (servidores de a uno, luego agentes). Antes, tome un
  respaldo de etcd: `rke2 etcd-snapshot save --name antes-de-actualizar`. Para volver atrás, reinstale la
  versión anterior y restaure el respaldo (`rke2 server --cluster-reset --cluster-reset-restore-path=...`)
  según la guía de RKE2.

## Notas

- En RHEL con SELinux en modo `enforcing`, use `rke2_metodo_instalacion: rpm` (incluye la política SELinux de
  RKE2; requiere acceso a `rpm.rancher.io` o a un espejo).
- El perfil CIS aplica Pod Security `restricted` a todo el clúster: el chart ya cumple esa política.
- Con `rke2_vsphere.habilitado: true`, RKE2 instala el CPI y el CSI de vSphere y crea la clase de
  almacenamiento `vsphere-csi`.
