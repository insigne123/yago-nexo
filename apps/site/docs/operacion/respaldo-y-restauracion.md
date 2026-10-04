---
title: Respaldo y restauración
description: Qué datos de Yago Nexo se respaldan, cómo se cifran, cuánto tiempo se conservan, RPO y RTO, la prueba de restauración verificada y lo que agrega una instalación de producción.
---

import EstadoCapacidad from '@site/src/components/EstadoCapacidad';

# Respaldo y restauración

Estado: <EstadoCapacidad id="respaldo" />

El respaldo es independiente de la alta disponibilidad. La réplica de PostgreSQL en el sitio de respaldo (ver [Continuidad entre sitios](../arquitectura.md#continuidad-entre-sitios)) cubre la caída de un sitio, pero copia también los errores: un borrado accidental, una migración defectuosa o datos cifrados por un atacante llegan a la réplica en segundos. El respaldo es una copia aparte, en otro almacenamiento, que permite volver a un punto anterior.

Esta página separa lo que hace hoy la herramienta del repositorio (`tools/respaldo`, paquete `@nexo/respaldo`) de lo que una instalación de producción agrega.

## Qué hace la herramienta y qué agrega producción

| Necesidad | `@nexo/respaldo` (en el repositorio, probado en el laboratorio) | Producción, además |
| --- | --- | --- |
| Respaldo completo de cada base | Sí: `pg_dump` consistente por base, más los roles de cada servidor. | Se mantiene como copia lógica independiente del operador de base de datos. |
| Pérdida de datos acotada a minutos y vuelta a un instante (PITR) | No. Con un respaldo diario se puede perder hasta un día. | CloudNativePG con Barman Cloud: respaldo base programado y archivo continuo del WAL en un almacenamiento de objetos. |
| Cifrado en reposo | Sí: AES-256-GCM antes de escribir en disco. | Además, cifrado del almacenamiento de objetos con llaves administradas. |
| Copia fuera del sitio | No: escribe en una carpeta. | La carpeta o el bucket se replica a otro sitio, con retención inmutable (bloqueo de objetos). |
| Retención | Sí: los N más recientes y un máximo de días. | La misma política, aplicada también al WAL y a los objetos del bucket. |
| Prueba de restauración | Sí: restaura en un PostgreSQL temporal, compara cada tabla, verifica la cadena de auditoría, mide el RTO y deja un informe. | Programada y con alerta si falla; recuperación a un instante probada en un clúster nuevo. |
| OpenSearch | No. | Snapshots a un repositorio (ver [OpenSearch](#opensearch)). |

## Qué se respalda

La herramienta respalda **cada base PostgreSQL** de los servidores configurados y los **roles** de cada servidor:

| Servidor | Base | Contenido |
| --- | --- | --- |
| principal | `apim_db` | WSO2 API Manager: APIs, revisiones, aplicaciones, suscripciones y políticas. |
| principal | `shared_db` | WSO2: usuarios, roles y registro compartidos entre nodos. |
| principal | `mi_db` | WSO2 Micro Integrator: coordinación del clúster. |
| principal | `nexo` | Consola Nexo: catálogo, grafo de dependencias, descubrimiento, anomalías, bloqueos, despliegues, continuidad, mensajes fallidos y la [cadena de auditoría](../seguridad.md#auditoria). |
| keycloak | `keycloak` | Keycloak: realms, clientes, usuarios, grupos y credenciales. |
| cada servidor | roles | Roles, membresías y contraseñas (como hash), con `pg_dumpall --globals-only`. |

Con `"bases": "todas"` entra toda base que acepte conexiones. En el laboratorio el servidor principal tiene además una base `keycloak` que el Keycloak actual no usa (usa su propio servidor) y la base `postgres`, vacía; las dos se respaldan igual.

Lo que esta herramienta **no** respalda, y cómo se cubre:

- **Configuración** (`deployment.toml` de WSO2, realm de Keycloak, plataforma como código, manifiestos): vive en Git y se recupera desde ahí.
- **Secretos** (OpenBao): tienen su propio snapshot y se guardan aparte, con otra custodia. Ver [Secretos](../seguridad.md#secretos).
- **OpenSearch** (logs, auditoría replicada, SIEM): snapshots, ver [más abajo](#opensearch).
- **RabbitMQ**: las definiciones (colas, intercambios, usuarios) se exportan con `rabbitmqctl export_definitions`; los mensajes en tránsito no se respaldan. Los mensajes que fallaron quedan registrados en la base `nexo`.
- **Métricas de Prometheus**: no se respaldan; tienen retención propia y no son datos de negocio.

## Cómo se toma un respaldo consistente

Por cada base:

1. Se abre una transacción `REPEATABLE READ` de solo lectura y se exporta su snapshot con `pg_export_snapshot()`.
2. Dentro de ese snapshot se cuentan las filas de cada tabla y se calcula una huella del contenido (suma de los MD5 de cada fila, que no depende del orden). En la base `nexo` se anota además el estado de la cadena de auditoría: cantidad de eventos, último `seq` y su hash.
3. `pg_dump -Fc --snapshot=<id>` vuelca exactamente esos datos. Los conteos del manifiesto y el contenido del archivo corresponden al mismo instante, aunque la plataforma siga escribiendo.
4. Se cierra la transacción.

La salida de `pg_dump` se cifra mientras se escribe: el volcado sin cifrar nunca queda en disco. Al final se escribe `manifiesto.json`, firmado, y se aplica la retención. Un respaldo solo aparece en la carpeta de destino cuando terminó completo; si algo falla, se borra lo parcial y el comando termina con error.

```text title="Carpeta de destino"
release/respaldos/
  20261004T164720Z/                 id = instante de inicio, en UTC
    manifiesto.json                 qué se respaldó, filas por tabla, SHA-256, versión de PostgreSQL
    principal/globales.sql.enc      roles del servidor principal
    principal/apim_db.pgdump.enc    una base por archivo, cifrada
    ...
    keycloak/keycloak.pgdump.enc
    informe-restauracion.json|md    resultado de la última prueba de restauración
```

El manifiesto registra, por base: archivo, tamaño, SHA-256 del archivo cifrado, versión de PostgreSQL, instante y posición del WAL del snapshot, filas y huella de cada tabla y la duración. También la versión de la herramienta y de `pg_dump`.

## Cifrado

- **Algoritmo.** AES-256-GCM por bloques de 1 MiB, cada bloque con su etiqueta de autenticación. La clave de cada archivo se deriva de la clave maestra con HKDF-SHA256 y una sal aleatoria del archivo. La cabecera va autenticada y el último bloque lleva una marca: se detecta un bloque alterado, reordenado o agregado, un archivo truncado y una clave equivocada.
- **Manifiesto firmado.** `manifiesto.json` lleva una firma HMAC-SHA256 con una clave derivada de la misma clave maestra. La prueba de restauración compara contra cifras que no se pueden editar sin la clave. El manifiesto incluye la huella de la clave (no la clave) para saber con cuál se cifró.
- **Archivos y carpetas** con permisos `600` y `700`.
- **Clave en el laboratorio.** La primera ejecución genera `deploy/compose/respaldo-lab.key`. Git la ignora; no se sube al repositorio.
- **Clave en producción.** `NEXO_RESPALDO_CLAVE` apunta a un archivo montado desde el gestor de secretos, con permisos `400` o `600`. Si la ruta viene de esa variable y el archivo no existe, la herramienta se detiene: nunca genera una clave por su cuenta.
- **Custodia.** Sin la clave no hay restauración. Guarde una copia en custodia separada de los respaldos (por ejemplo, en un sobre sellado o en un segundo gestor de secretos con otro administrador). Para rotarla, use la nueva solo para los respaldos nuevos y conserve la anterior hasta que venza el último respaldo cifrado con ella.
- **Durante la prueba de restauración** el contenido descifrado existe solo dentro del contenedor temporal, que se elimina con sus volúmenes al terminar.

Se genera una clave nueva con:

```bash
pnpm --filter @nexo/respaldo exec tsx src/cli.ts generar-clave --salida /ruta/segura/respaldo.key
```

## Retención y ciclo de vida de los datos

La política tiene dos reglas:

- **`conservar`**: cantidad de respaldos completos que se mantienen (laboratorio: 7).
- **`maximoDias`**: ningún respaldo vive más que esto (laboratorio: 35). El respaldo más reciente nunca se borra, aunque supere el máximo; en ese caso la herramienta avisa, porque significa que no se están tomando respaldos nuevos.

La retención se aplica al terminar cada respaldo y no borra un respaldo que esté en una prueba de restauración.

Los respaldos contienen datos personales. Un dato que se elimina en producción sigue en los respaldos hasta que estos vencen: el máximo de días es el plazo máximo en que sobrevive. Si se restaura un respaldo, hay que volver a aplicar las solicitudes de supresión atendidas después de la fecha de ese respaldo.

Recomendación para producción: 14 respaldos diarios con un máximo de 35 días, y la misma ventana para el archivo de WAL y los respaldos base de CloudNativePG.

## RPO y RTO

| Medida | Solo con esta herramienta | Producción con archivo continuo de WAL |
| --- | --- | --- |
| RPO (cuántos datos se pueden perder) | Hasta el intervalo entre respaldos: con un respaldo diario, hasta 24 horas. | Minutos: lo que tarde en archivarse el último segmento de WAL (por ejemplo, 5 minutos si se fuerza el cierre de segmento con ese intervalo). |
| RTO (cuánto tarda la restauración) | Medido en cada prueba de restauración. | Se mide con la recuperación en un clúster nuevo; crece con el tamaño de las bases. |

Estos valores son para recuperarse **desde un respaldo**. Ante la caída de un sitio rige la conmutación a la réplica, que tiene su propio RTO y RPO medidos (ver [Continuidad entre sitios](../arquitectura.md#continuidad-entre-sitios)).

### RTO medido en el laboratorio

Prueba del 4 de octubre de 2026, con el laboratorio en uso y escribiendo:

| Paso | Tiempo |
| --- | ---: |
| Verificar la firma del manifiesto y el SHA-256 de los 9 archivos (2,10 MiB) | 0,04 s |
| Levantar el PostgreSQL temporal del servidor principal | 2,4 s |
| Roles del servidor principal | 0,2 s |
| `apim_db` · `keycloak` · `mi_db` · `nexo` · `postgres` · `shared_db` | 4,4 s · 2,3 s · 0,5 s · 0,9 s · 0,5 s · 1,6 s |
| Levantar el PostgreSQL temporal del servidor keycloak | 2,7 s |
| Roles y base `keycloak` del servidor keycloak | 0,3 s y 2,1 s |
| **RTO medido** | **17,9 s** |
| Comparación posterior (no cuenta para el RTO) | 4,4 s |

Resultado: 2 servidores, 7 bases, 526 tablas y 13.122 filas comparadas, **0 diferencias**; la cadena de auditoría restaurada (234 eventos) se verificó completa y su último hash coincide con el del respaldo. Una prueba anterior del mismo día midió 13,9 s.

El RTO medido cuenta la verificación de los archivos, el arranque del servidor y la restauración de roles y bases. En un incidente real se suman el tiempo de decisión, la preparación del servidor definitivo y el reinicio de WSO2 y de la Consola contra la base restaurada. En producción se mide con los datos reales: el objetivo se fija en la configuración (`objetivos.rtoMinutos`) y la prueba falla si se supera.

## Calendario recomendado

| Tarea | Frecuencia | Cómo |
| --- | --- | --- |
| Respaldo lógico de todas las bases | Diario, en horario de baja carga | `nexo-respaldo respaldar` desde cron o un `CronJob` de Kubernetes. |
| Prueba de restauración del último respaldo | Semanal, después del respaldo | `nexo-respaldo restaurar`; el informe queda junto al respaldo. |
| Respaldo base de CloudNativePG | Diario | `ScheduledBackup` con Barman Cloud. |
| Archivo de WAL | Continuo | Barman Cloud hacia el almacenamiento de objetos. |
| Recuperación a un instante en un clúster nuevo | Trimestral | Clúster de prueba creado desde el respaldo base y el WAL, con un instante objetivo. |
| Snapshot de OpenSearch | Diario | Política de Snapshot Management. |

Las dos órdenes terminan con código distinto de 0 si algo falla. La tarea programada debe alertar en ese caso.

## Ejecutar en el laboratorio

Con el laboratorio arriba, desde la raíz del repositorio:

```bash
# Respaldo de todas las bases (compila las bibliotecas que usa y lee deploy/compose/.env)
make -C deploy/compose respaldo

# Prueba de restauración del último respaldo
make -C deploy/compose restaurar-prueba

# Respaldos disponibles y resultado de su última prueba
pnpm --filter @nexo/respaldo listar
```

La prueba de restauración:

1. Verifica la firma del manifiesto con la clave y el SHA-256 de cada archivo.
2. Levanta un PostgreSQL temporal por servidor (contenedor `nexo-respaldo-prueba-*`, sin puertos publicados y con un superusuario propio, para que los roles restaurados no choquen).
3. Restaura los roles con `psql` y cada base con `pg_restore --create --exit-on-error`, descifrando al vuelo.
4. Compara cada tabla con el manifiesto: deben coincidir exactamente las tablas, las filas y la huella del contenido.
5. En la base `nexo`, cuenta los eventos de auditoría, compara el último `seq` y su hash y vuelve a verificar la cadena completa con el mismo código que usa la Consola.
6. Mide el RTO, escribe `informe-restauracion.json` y `informe-restauracion.md` en la carpeta del respaldo y elimina el contenedor, también si algo falló o si se interrumpe con Ctrl-C.

Termina con código 1 ante cualquier diferencia, archivo alterado o error. Salida de la prueba del 4 de octubre de 2026 (resumida):

```text
Prueba de restauración del respaldo 20261004T164720Z
Manifiesto firmado y 9 archivos verificados (2,10 MiB) en 0,0 s
Servidor principal: PostgreSQL temporal 16.15 listo en 2,4 s
  apim_db: 247/247 tablas, 3140/3140 filas → ok
  nexo: 25/25 tablas, 419/419 filas, auditoría íntegra y coincidente → ok
  ...
Servidor keycloak: PostgreSQL temporal 16.15 listo en 2,7 s
  keycloak: 101/101 tablas, 1905/1905 filas → ok

PRUEBA DE RESTAURACIÓN EXITOSA · respaldo 20261004T164720Z
  7 bases restauradas y comparadas: 526 tablas, 13122 filas, 0 diferencias
  RTO medido: 17,9 s (duración total con la comparación: 22,3 s)
```

Requisitos: Docker y la imagen `postgres:16-alpine`. La herramienta se conecta al PostgreSQL temporal por su IP en la red de Docker, lo que funciona en Linux; en Docker Desktop (macOS, Windows) esa IP no es accesible desde el equipo.

## Configuración

El archivo `tools/respaldo/respaldo.config.example.json` es la configuración del laboratorio. Para otra instalación, cópielo a `tools/respaldo/respaldo.config.json` (ignorado por git) o indique otro archivo con `NEXO_RESPALDO_CONFIG`. Las contraseñas nunca van en el archivo: cada servidor indica en `claveEnv` la variable de entorno que la contiene.

| Campo | Qué define |
| --- | --- |
| `modo` | `docker`: `pg_dump` corre en un contenedor efímero en la red de los servidores (laboratorio). `local`: usa los binarios instalados (producción). |
| `destino` | Carpeta de los respaldos. |
| `clave` | Archivo de la clave maestra (32 bytes en hexadecimal o base64). |
| `retencion` | `conservar` y `maximoDias`. |
| `objetivos` | `rtoMinutos` (la prueba falla si se supera) y `rpoHoras` (avisa si el respaldo probado es más antiguo). |
| `servidores[]` | `nombre`, `host`, `puerto`, `usuario`, `claveEnv`, `bases` (`"todas"` o una lista), `excluir`, `globales`, `tls` (`desactivado`, `requerido` o `verificar` con `ca`). En modo docker, `cliente` o `contenedor` indican cómo llega la herramienta al servidor. |
| `restauracion` | Imagen del PostgreSQL temporal (misma versión mayor que producción) y trabajos paralelos de `pg_restore`. |

Variables de entorno, que prevalecen sobre el archivo:

| Variable | Valor |
| --- | --- |
| `NEXO_RESPALDO_CONFIG` | Ruta del archivo de configuración. |
| `NEXO_RESPALDO_MODO` | `docker` o `local`. |
| `NEXO_RESPALDO_DESTINO` | Carpeta de destino. |
| `NEXO_RESPALDO_CLAVE` | Ruta del archivo de clave. |
| `NEXO_RESPALDO_CONSERVAR` | Cantidad de respaldos que se conservan. |
| `NEXO_RESPALDO_MAXIMO_DIAS` | Máximo de días (`0` = sin máximo). |
| `NEXO_RESPALDO_RED` | Red de Docker de los servidores (modo docker). |
| `NEXO_RESPALDO_IMAGEN` | Imagen con `pg_dump` y `pg_restore`. |
| `NEXO_RESPALDO_BINARIOS` | Carpeta con `pg_dump` y `pg_dumpall` (modo local). |

En producción, `pg_dump` debe ser de la misma versión mayor que el servidor o más nueva, y el usuario de respaldo necesita leer todas las tablas y, para los roles con sus contraseñas, ser superusuario.

## OpenSearch {#opensearch}

OpenSearch guarda los logs, la copia de la auditoría para búsqueda y correlación y los eventos del SIEM (índices `nexo-logs-*`, `nexo-audit-*`, `nexo-siem-*` y `nexo-apim-metrics-*`). La cadena de auditoría original vive en PostgreSQL y queda en el respaldo de la base `nexo`.

El laboratorio no automatiza estos snapshots (es un solo nodo, sin repositorio). Procedimiento de producción:

1. **Registrar un repositorio de snapshots** en un almacenamiento de objetos, con el plugin correspondiente (`repository-s3` o `repository-gcs`) instalado en todos los nodos:

   ```text
   PUT _snapshot/nexo-respaldos
   { "type": "s3", "settings": { "bucket": "<bucket-de-respaldos>", "base_path": "opensearch" } }
   ```

2. **Programar los snapshots** con una política de Snapshot Management, con la misma retención que los respaldos de base de datos:

   ```text
   POST _plugins/_sm/policies/nexo-diario
   {
     "description": "Snapshot diario de los índices de Nexo",
     "creation": { "schedule": { "cron": { "expression": "0 3 * * *", "timezone": "America/Santiago" } } },
     "deletion": {
       "schedule": { "cron": { "expression": "0 4 * * *", "timezone": "America/Santiago" } },
       "condition": { "max_age": "35d", "min_count": 7 }
     },
     "snapshot_config": { "repository": "nexo-respaldos", "indices": "nexo-*", "include_global_state": false }
   }
   ```

3. **Restaurar** los índices de un snapshot en un clúster de prueba y comparar la cantidad de documentos:

   ```text
   POST _snapshot/nexo-respaldos/<snapshot>/_restore
   { "indices": "nexo-audit-*", "rename_pattern": "(.+)", "rename_replacement": "restaurado-$1" }
   ```

El bucket debe estar cifrado y replicado fuera del sitio, como el de los respaldos de PostgreSQL.
