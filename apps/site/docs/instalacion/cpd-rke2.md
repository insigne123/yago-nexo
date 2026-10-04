---
title: CPD con RKE2
description: Instalación de producción en el CPD. Máquinas virtuales en VMware vSphere, Kubernetes RKE2 con perfil CIS mediante Ansible y la plataforma con Helm; requisitos, pasos, verificación y vuelta atrás.
---

import EstadoCapacidad from '@site/src/components/EstadoCapacidad';

# CPD con RKE2

Estado: <EstadoCapacidad id="instalador-rke2" /> · chart: <EstadoCapacidad id="helm" />

El playbook `deploy/ansible/rke2/site.yml` prepara las máquinas virtuales, instala RKE2 en versión fija con el perfil CIS, une los nodos, instala Helm y despliega la plataforma con `values-cpd.yaml`. Cada ejecución es idempotente: si nada cambió, termina sin cambios.

## Requisitos {#requisitos}

### Máquinas virtuales

| Rol | Cantidad | vCPU | Memoria | Disco de datos |
| --- | --- | --- | --- | --- |
| Servidor RKE2 (plano de control y etcd) | 3 | 4 o más | 16 GB o más | 100 GB o más en `/dev/sdb` |
| Agente RKE2 (nodo de trabajo) | 11 | 8 | 32 GB | 100 GB o más en `/dev/sdb` |

- Sistema operativo: RHEL, Rocky o Alma Linux 8 o 9, Ubuntu 22.04 o 24.04, o SLES 15, en x86_64.
- Nombres de nodo en minúsculas, dígitos y guiones; sin memoria de intercambio (el playbook la apaga).
- En vSphere: `disk.EnableUUID = TRUE` en cada máquina si se usarán volúmenes del CSI de vSphere.
- Acceso SSH con `sudo` desde la máquina de control.

### Red

- Un nombre o VIP para los servidores (puertos 6443 de la API y 9345 de registro de nodos).
- Un balanceador del CPD hacia los puertos 80 y 443 de los agentes, donde corre Traefik (el controlador de Ingress de RKE2 1.36). Esa es la IP de entrada del sitio.
- Servidores NTP alcanzables.
- Entre nodos, los puertos de RKE2 con Canal: el playbook los abre en firewalld o ufw (TCP 6443, 9345, 2379-2381, 10250, 30000-32767, 9099, 80 y 443; UDP 8472).
- Sin Internet: un registro de imágenes (Harbor) con las imágenes de RKE2 y de Nexo, y los artefactos de RKE2 copiados en cada nodo (`rke2_ruta_artefactos`).

### Servicios y Secrets

- PostgreSQL, RabbitMQ, OpenSearch, Keycloak, Prometheus y el colector de OpenTelemetry, alcanzables desde el clúster ([Valores por ambiente](./valores-por-ambiente.md#dependencias) indica su tamaño).
- Los Secrets de la plataforma. Los de texto (contraseñas, llave de cifrado de WSO2, URLs de bases) los crea el playbook desde Ansible Vault; los almacenes de llaves de WSO2, el certificado TLS, la CA interna y la credencial del registro se crean con `kubectl`.

### Máquina de control

- Python 3.10 o superior y `ansible-core` 2.16 o superior.
- Una copia del repositorio de Nexo en la versión que se instalará.

## Pasos {#pasos}

1. **Colecciones de Ansible.**

   ```bash
   cd deploy/ansible/rke2
   ansible-galaxy collection install -r requirements.yml -p colecciones
   ```

2. **Inventario del sitio.** Copie el de ejemplo y ajuste nombres, direcciones, discos, NTP, VIP y registro:

   ```bash
   cp -r inventario/ejemplo inventario/cpd
   ```

   Los datos principales están en `inventario/cpd/group_vars/all/principal.yml`: `rke2_version` (fija, `v1.36.5+rke2r1`), `rke2_perfil_cis`, `rke2_direccion_registro`, `preparar_host_ntp`, `preparar_host_firewall` y `preparar_host_discos`.

3. **Secretos en Ansible Vault.**

   ```bash
   cp inventario/cpd/group_vars/all/vault.yml.ejemplo inventario/cpd/group_vars/all/vault.yml
   # complete los valores y cifre:
   ansible-vault encrypt inventario/cpd/group_vars/all/vault.yml
   ```

4. **Valores del sitio para el chart** (nombres públicos, direcciones de los servicios externos, IP de los sitios). Van en `inventario/cpd/valores-sitio.yaml`, fuera del repositorio y sin contraseñas:

   ```bash
   cp inventario/cpd/valores-sitio.yaml.ejemplo inventario/cpd/valores-sitio.yaml
   ```

5. **Revisión previa.**

   ```bash
   ansible-playbook -i inventario/cpd/hosts.yml site.yml --syntax-check
   ansible -i inventario/cpd/hosts.yml rke2_cluster -m ansible.builtin.ping
   ```

6. **Kubernetes.** Prepara los hosts, instala los 3 servidores de a uno y une los agentes:

   ```bash
   ansible-playbook -i inventario/cpd/hosts.yml site.yml --ask-vault-pass --tags preparar,rke2
   ```

7. **Secrets binarios** (una vez), desde el primer servidor. La primera ejecución de la etiqueta `plataforma` crea el espacio de nombres `nexo` y se detiene con la lista de los Secrets que faltan:

   ```bash
   export KUBECONFIG=/etc/rancher/rke2/rke2.yaml PATH=$PATH:/var/lib/rancher/rke2/bin
   kubectl -n nexo create secret generic nexo-wso2-almacen \
     --from-file=wso2carbon.jks --from-file=client-truststore.jks \
     --from-literal=keystore-password='<contraseña>'
   kubectl -n nexo create secret tls nexo-tls --cert=nexo.crt --key=nexo.key
   kubectl -n nexo create secret generic nexo-ca-interna --from-file=ca.crt
   kubectl -n nexo create secret docker-registry harbor-nexo --docker-server=<registro> \
     --docker-username='<usuario>' --docker-password='<contraseña>'
   ```

   El certificado de WSO2 (`wso2carbon.jks`) debe estar firmado por la CA interna e incluir el nombre `wso2.nexo.internal` (lo verifica Traefik) y los nombres de servicio internos (`*.nexo.svc`).

8. **Plataforma.**

   ```bash
   ansible-playbook -i inventario/cpd/hosts.yml site.yml --ask-vault-pass --tags helm,plataforma
   ```

   El rol ejecuta `helm upgrade --install nexo-platform` con `values-cpd.yaml` y `valores-sitio.yaml`, espera a que todo quede listo (hasta 30 minutos: API Manager tarda en arrancar la primera vez) y muestra los pods. Si el clúster no tiene Prometheus Operator, instala sin ServiceMonitors y lo avisa.

## Verificación {#verificacion}

Desde el primer servidor:

```bash
export KUBECONFIG=/etc/rancher/rke2/rke2.yaml PATH=$PATH:/var/lib/rancher/rke2/bin

kubectl get nodes -o wide                         # 14 nodos Ready, todos en v1.36.5+rke2r1
kubectl -n nexo get pods -o wide                  # todo Running y listo; réplicas en nodos distintos
kubectl -n nexo get pdb,hpa,networkpolicy         # presupuestos, autoescalamiento y políticas de red
helm -n nexo status nexo-platform                 # STATUS: deployed
kubectl -n nexo logs job/nexo-platform-km-registro  # "Key Manager creado" o "actualizado"
```

Desde la red de los consumidores:

```bash
curl -s https://apim.nexo.example/services/Version          # versión de WSO2 (Control Plane)
curl -s -o /dev/null -w '%{http_code}\n' https://operadores.nexo.example/   # responde el gateway (404: no hay API en /)
```

Luego, la prueba de punta a punta: publique una API de prueba en el ambiente `Operadores`, obtenga un token de Keycloak con `client_credentials` para una aplicación suscrita y llame a la API por `https://operadores.nexo.example`. Sin token el gateway debe responder 401. La misma API no debe existir en el gateway `publico`.

Por último, vuelva a ejecutar el playbook completo: debe terminar con `changed=0` en todos los hosts.

## Vuelta atrás {#vuelta-atras}

| Qué | Cómo |
| --- | --- |
| Una actualización de la plataforma | `helm -n nexo history nexo-platform` y `helm -n nexo rollback nexo-platform <revisión> --wait`. Las bases no se tocan: un cambio de esquema de WSO2 se revierte desde el respaldo de PostgreSQL. |
| Valores del sitio | Vuelva `valores-sitio.yaml` a la versión anterior y ejecute `--tags plataforma`. |
| Una actualización de RKE2 | Antes de actualizar, `rke2 etcd-snapshot save --name antes-de-actualizar` en un servidor. Para volver, reinstale la versión anterior (`rke2_version`) y restaure el respaldo con `rke2 server --cluster-reset --cluster-reset-restore-path=<respaldo>` siguiendo la guía de RKE2. |
| Desinstalar la plataforma | `helm -n nexo uninstall nexo-platform`. Los Secrets y las bases externas quedan intactos. |
| Retirar un nodo | `kubectl drain <nodo> --ignore-daemonsets --delete-emptydir-data` (los presupuestos de interrupción sacan una réplica a la vez), luego quítelo del inventario. |
