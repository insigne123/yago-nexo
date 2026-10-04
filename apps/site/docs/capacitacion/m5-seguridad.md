---
title: "M5 · Seguridad e identidad"
sidebar_label: "M5 · Seguridad e identidad"
description: Módulo M5 de la capacitación de Yago Nexo (5 horas). Tokens y TLS, auditoría con cadena de hash, guardián de anomalías con bloqueo, descubrimiento de APIs no gobernadas y separación de audiencias.
---

import EstadoCapacidad from '@site/src/components/EstadoCapacidad';
import { SiNoDisponible } from '@site/src/components/SegunEstado';

# M5 · Seguridad e identidad

**Duración:** 5 horas · **Sesión:** 6 · **Rutas:** Desarrollo/APIs, Seguridad y Certificación

## Objetivos de aprendizaje

Al terminar el módulo, el participante:

1. Lee un token de acceso, explica cómo lo valida el gateway y comprueba la configuración TLS.
2. Verifica la cadena de auditoría y demuestra que una alteración se detecta.
3. Configura una regla del guardián de anomalías y sigue un bloqueo desde la detección hasta su vencimiento.
4. Ejecuta un escaneo de descubrimiento, interpreta el puntaje de exposición y clasifica hallazgos.
5. Explica cómo se separan las audiencias y qué controles están en desarrollo.

## Agenda

| Bloque | Tiempo | Contenido |
| --- | --- | --- |
| 1 | 0:00 – 0:30 | Modelo de seguridad de Nexo: identidad, mínimo privilegio, auditoría, TLS, secretos y datos personales. |
| 2 | 0:30 – 1:15 | [Ejercicio 5.1](#ejercicio-5-1): tokens, audiencias y TLS. |
| 3 | 1:15 – 2:00 | [Ejercicio 5.2](#ejercicio-5-2): auditoría con cadena de hash. |
| — | 2:00 – 2:15 | Pausa. |
| 4 | 2:15 – 3:30 | [Ejercicio 5.3](#ejercicio-5-3): guardián de anomalías. |
| — | 3:30 – 3:45 | Pausa. |
| 5 | 3:45 – 4:45 | [Ejercicio 5.4](#ejercicio-5-4): descubrimiento de APIs no gobernadas. |
| 6 | 4:45 – 5:00 | Controles en desarrollo. Cierre y autoevaluación. |

## Conceptos

### Identidad y tokens

- Las aplicaciones obtienen tokens `client_credentials` de Keycloak (<EstadoCapacidad id="keycloak-key-manager" />). El gateway valida el JWT con las llaves públicas del realm (validación propia del JWT) y comprueba que la aplicación esté suscrita a la API.
- La API de la Consola valida los tokens de las personas contra el mismo Keycloak: token ausente o alterado, **401**; sin el permiso, **403**.
- En el realm de laboratorio el token de acceso dura 15 minutos y hay protección contra fuerza bruta.

### TLS

API Manager acepta solo **TLS 1.2 y TLS 1.3** en el puerto de portales y REST API (9443) y en el gateway HTTPS (8243). La Consola publica la matriz de canales observados (`GET /compliance/tls-channels`). En el laboratorio, API Manager usa el certificado autofirmado de su distribución y Keycloak corre por HTTP: no es una configuración de producción.

### Auditoría con cadena de hash

Cada acción de escritura de la Consola y de los motores genera un evento con quién, qué, sobre qué recurso, resultado y cuándo. Cada evento lleva su número de secuencia y el hash del anterior: `hash = SHA-256(prevHash + evento en forma canónica)`; el primero parte de 64 ceros. La verificación detecta tres fallas: **secuencia** (falta o sobra un evento), **encadenamiento** (no calza con el anterior) y **hash** (el contenido cambió). Ver [Seguridad](../seguridad.md#auditoria) y <EstadoCapacidad id="auditoria-centralizada" />.

### Guardián de anomalías

El guardián calcula una línea base por API y consumidor con ventanas de tiempo (30 segundos en el laboratorio) y compara la ventana actual con **mediana y MAD**, que no se dejan arrastrar por picos aislados (<EstadoCapacidad id="motor-anomalias" />). Cada regla define:

| Campo | Valores |
| --- | --- |
| `metric` | `volumen`, `errores`, `latencia`, `tamano`, `ips_distintas`, `fuera_de_horario` |
| `sensitivity` | 1 (poco sensible) a 10 (muy sensible) |
| `minVolume` | Llamadas mínimas en la ventana para evaluar |
| `action` | `alertar`, `bloquear_automatico` (con duración `blockTtlMinutes`) o `bloquear_con_aprobacion` |

Un bloqueo es una **política de denegación** del gateway: el consumidor recibe 403. El automático vence solo; el propuesto espera a un aprobador (cuatro ojos) y se libera con motivo.

### Descubrimiento de APIs no gobernadas

El motor de descubrimiento revisa otros gateways (APISIX), servidores web (configuración y registro de accesos del NGINX heredado) y la red autorizada (rutas típicas de contratos), compara con el catálogo y calcula un **puntaje de exposición** con sus motivos: sin autenticación, datos personales, contrato publicado, backend gobernado accesible sin pasar por el gateway (<EstadoCapacidad id="motor-descubrimiento" />). Las personas con rol aprobador clasifican cada hallazgo (`gobernado`, `riesgo_aceptado`, `en_migracion`, `descartado`) y esa clasificación se respeta en los escaneos siguientes.

### Audiencias

Cada audiencia tiene su gateway y su portal: interna (Default), entidades externas (Operadores) y público (Publico, en un gateway separado). Una API desplegada solo para una audiencia responde 404 en los gateways de las demás (<EstadoCapacidad id="audiencias" />).

### Controles de identidad, datos y secretos {#en-desarrollo}

<SiNoDisponible id="sso-keycloak">

:::note En desarrollo

Los controles marcados *En desarrollo* todavía no forman parte del laboratorio; se revisan en la sesión sin ejercicios.

:::

</SiNoDisponible>

| Control | Estado |
| --- | --- |
| Inicio de sesión único de las personas en los portales de WSO2 y la Consola | <EstadoCapacidad id="sso-keycloak" /> |
| Enmascaramiento de RUT, correos, teléfonos, tarjetas y tokens en los logs (la auditoría no se enmascara: la identidad de quien actúa es evidencia) | <EstadoCapacidad id="enmascaramiento-logs" /> |
| Gestor de secretos para producción (OpenBao, External Secrets, Secure Vault) | <EstadoCapacidad id="secretos" /> |

Lo que sí existe hoy en el laboratorio: Fluent Bit enmascara los datos personales y secretos de los logs antes de enviarlos (se comprueba con `deploy/compose/fluent-bit/pruebas/probar-enmascaramiento.sh`, que levanta un Fluent Bit aparte y no toca el laboratorio), la vista previa de los mensajes fallidos enmascara el RUT (M4) y el colector de trazas elimina el encabezado `Authorization` y reemplaza el identificador de usuario final por un hash.

## Ejercicios de laboratorio

Cargue las ayudas en cada terminal: `source tools/lab-bootstrap/ayudas-curso.sh`.

### Ejercicio 5.1 · Tokens, audiencias y TLS {#ejercicio-5-1}

**Objetivo.** Ver qué valida el gateway, cómo se separan las audiencias y qué versiones de TLS acepta la plataforma.

**Pasos.**

1. Llame con un token válido y con uno alterado:

   ```bash
   APP=$(app_tok OperadorDemo)
   URL="https://apim:8243/concesiones/1.0.0/concesiones"
   curl -sk -o /dev/null -w 'token válido   → %{http_code}\n' -H "Authorization: Bearer $APP" "$URL"
   curl -sk -o /dev/null -w 'token alterado → %{http_code}\n' -H "Authorization: Bearer ${APP%????}AAAA" "$URL"
   curl -s  -o /dev/null -w 'Consola, token alterado → %{http_code}\n' -H "Authorization: Bearer ${APP%????}AAAA" http://localhost:8090/api/v1/me
   ```

2. Compruebe las audiencias:

   ```bash
   curl -sk -o /dev/null -w 'pública por gw-publico → %{http_code}\n' -H "Authorization: Bearer $APP" https://publico.nexo.lab:18243/publico/concesiones/1.0.0/concesiones/CON-000001
   curl -sk -o /dev/null -w 'pública por el interno → %{http_code}\n' -H "Authorization: Bearer $APP" https://apim:8243/publico/concesiones/1.0.0/concesiones/CON-000001
   ```

   (Si la primera da 403 o 401, OperadorDemo no está suscrita a ConsultaPublica: ejecute `pnpm --filter @nexo/lab-bootstrap check:audiencias`, que la suscribe.)

3. Pruebe TLS 1.1 y TLS 1.2 contra el gateway, y vea la matriz de canales de la Consola:

   ```bash
   openssl s_client -connect apim:8243 -tls1_1 < /dev/null 2>&1 | grep -E "Protocol|alert|error" | head -3
   openssl s_client -connect apim:8243 -tls1_2 < /dev/null 2>&1 | grep -E "Protocol" | head -1
   consola pedro.auditoria GET /compliance/tls-channels | jq -c '.[] | {canal, versiones, rechazaTls10}'
   ```

**Resultado esperado.** Token válido, `200`; token alterado, `401` en el gateway y `401` en la Consola. La API pública responde `200` por `gw-publico` y `404` por el gateway interno. El intento con TLS 1.1 falla en el saludo (alerta o error de protocolo) y el de TLS 1.2 informa `Protocol: TLSv1.2`. La matriz de canales muestra solo TLS 1.2 o 1.3 y `rechazaTls10: true` en cada canal.

**Autoevaluación.**

- ¿Por qué un token alterado da 401 y no 403?

<details>
<summary>Respuesta</summary>

Porque la firma no corresponde: no se sabe quién llama (falla de autenticación, 401). El 403 es para alguien autenticado al que le falta un permiso o una suscripción.

</details>

### Ejercicio 5.2 · Auditoría con cadena de hash {#ejercicio-5-2}

**Objetivo.** Verificar la cadena de auditoría y demostrar que una alteración en la base se detecta.

**Pasos.**

1. Vea los últimos eventos y verifique la cadena:

   ```bash
   consola pedro.auditoria GET '/audit-events?limit=5' | jq -c '.[] | {seq, actor, action, result}'
   consola pedro.auditoria GET /audit-events/verify | jq
   ```

2. Respalde el evento 2 y altérelo directamente en PostgreSQL:

   ```bash
   cd deploy/compose
   docker compose --env-file .env exec -T postgres psql -U nexo -d nexo -c "CREATE TABLE nexo.respaldo_ejercicio AS SELECT seq, details FROM nexo.audit_event WHERE seq = 2"
   docker compose --env-file .env exec -T postgres psql -U nexo -d nexo -c "UPDATE nexo.audit_event SET details = '{\"alterado\": true}' WHERE seq = 2"
   cd ../..
   consola pedro.auditoria GET /audit-events/verify | jq
   ```

3. Restaure el evento y verifique de nuevo:

   ```bash
   cd deploy/compose
   docker compose --env-file .env exec -T postgres psql -U nexo -d nexo -c "UPDATE nexo.audit_event e SET details = r.details FROM nexo.respaldo_ejercicio r WHERE e.seq = r.seq"
   docker compose --env-file .env exec -T postgres psql -U nexo -d nexo -c "DROP TABLE nexo.respaldo_ejercicio"
   cd ../..
   consola pedro.auditoria GET /audit-events/verify | jq
   ```

**Resultado esperado.** La primera verificación responde `"ok": true` con el número de eventos. Con el evento alterado responde `"ok": false`, `"brokenAt": 2` y `"reason": "hash"`. Restaurado, vuelve a `"ok": true`. Cada verificación queda a su vez auditada (`auditoria.verificar`). La verificación `check:consola` hace esta misma prueba de forma automática.

**Autoevaluación.**

- Si alguien borra el evento 3 en vez de modificarlo, ¿qué falla esperaría?
- ¿Por qué el SIEM puede comprobar la cadena sin acceso a la base de la Consola?

<details>
<summary>Respuestas</summary>

Una falla de `secuencia`: después del 2 llegaría el 4. Porque cada evento lleva su `seq`, su `prevHash` y su `hash`: basta recorrerlos en orden y recalcular, que es lo que hace `check:siem` con los eventos de OpenSearch.

</details>

### Ejercicio 5.3 · Guardián de anomalías {#ejercicio-5-3}

**Objetivo.** Crear una regla de bloqueo automático y seguir un bloqueo desde la detección hasta su vencimiento.

**Requisitos.** Perfil `obs` arriba (el guardián lee la analítica del gateway en OpenSearch) y ninguna otra prueba de carga corriendo.

**Pasos.**

1. Cree la regla sobre la API Concesiones:

   ```bash
   consola ana.desarrollo POST /catalog/sync > /dev/null
   API=$(consola luis.aprobador GET '/apis?q=Concesiones' | jq -r '.[] | select(.name == "Concesiones") | .wso2ApiId')
   REGLA='{"name":"Curso: ráfaga de un consumidor","apiId":"'"$API"'","metric":"volumen","sensitivity":6,"minVolume":30,"action":"bloquear_automatico","blockTtlMinutes":1,"enabled":true}'
   R=$(consola admin.nexo POST /anomaly-rules "$REGLA" | jq -r .id); echo "regla $R"
   ```

2. Genere tráfico normal y luego una ráfaga con OperadorDemo:

   ```bash
   pnpm --filter @nexo/lab-bootstrap carga -- --rps 2 --segundos 40
   pnpm --filter @nexo/lab-bootstrap carga -- --rps 20 --segundos 150
   ```

   Cuando la ráfaga empiece a mostrar segundos con `ok=0`, espere unos 5 segundos y deténgala con Ctrl+C: si sigue, el guardián volverá a bloquear cuando venza el bloqueo.

3. Revise la anomalía y el bloqueo:

   ```bash
   consola luis.aprobador GET /anomalies | jq '.[0] | {status, consumer, metric, observed, baseline, score, blockId}'
   consola luis.aprobador GET /blocks | jq '.[] | {id, active, conditionValue, expiresAt, releasedBy}'
   ```

4. Espere a que venza el bloqueo (1 minuto) y compruebe el acceso y la auditoría:

   ```bash
   curl -sk -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(app_tok OperadorDemo)" https://apim:8243/concesiones/1.0.0/concesiones
   consola pedro.auditoria GET '/audit-events?action=anomalias&limit=10' | jq -c '.[] | {action, actor}'
   ```

5. Desactive su regla:

   ```bash
   consola admin.nexo PATCH "/anomaly-rules/$R" "$(jq -c '.enabled = false' <<< "$REGLA")" | jq '{name, enabled}'
   ```

**Resultado esperado.** Durante la ráfaga, la anomalía queda `bloqueada` con el consumidor OperadorDemo, el valor observado muy sobre la línea base y un `blockId`; la ráfaga pasa a segundos con `ok=0` y errores (el gateway responde 403) en menos de 2 minutos. El bloqueo vence solo: queda `active: false` con `releasedBy: "nexo-guardian"` y el acceso vuelve a `200`. La auditoría muestra `anomalias.regla.crear`, `anomalias.detectar`, `anomalias.bloqueo.automatico` y `anomalias.bloqueo.vencer`. La regla queda `enabled: false`.

La variante con aprobación (`bloquear_con_aprobacion`: la anomalía queda `bloqueo_propuesto` hasta que un aprobador la aprueba con `POST /anomalies/<id>/approve-block`, y se libera con `POST /blocks/<id>/release`) es parte de la evaluación práctica; `check:d02` verifica las dos variantes.

**Autoevaluación.**

- ¿Por qué la regla exige un volumen mínimo?
- ¿Cuándo conviene `bloquear_con_aprobacion` en vez de `bloquear_automatico`?

<details>
<summary>Respuestas</summary>

Para no evaluar ventanas con muy pocas llamadas, donde cualquier variación parece anómala. La aprobación conviene cuando bloquear por error tiene un costo alto (por ejemplo, un consumidor crítico): el guardián propone y una persona distinta decide.

</details>

### Ejercicio 5.4 · Descubrimiento de APIs no gobernadas {#ejercicio-5-4}

**Objetivo.** Encontrar las APIs publicadas fuera de la plataforma, priorizarlas por exposición y clasificarlas.

**Requisitos.** Perfil `legacy` arriba y `make -C deploy/compose legado` ejecutado.

**Pasos.**

1. Inicie un escaneo como operador y espere a que termine:

   ```bash
   S=$(consola carla.operacion POST /discovery/scans '{"sources":["apisix","nginx","red"]}' | jq -r .id)
   while [ "$(consola carla.operacion GET /discovery/scans | jq -r --arg s "$S" '.[] | select(.id == $s) | .status')" = "en_curso" ]; do sleep 3; done
   consola carla.operacion GET /discovery/scans | jq --arg s "$S" '.[] | select(.id == $s) | {status, totals}'
   ```

2. Revise los hallazgos, ordenados por exposición:

   ```bash
   consola luis.aprobador GET /discovery/findings | jq -r '.[] | "\(.exposureScore)  \(.source)  \(.host)\(.path)  auth=\(.authDetected)  datosPersonales=\(.personalDataSuspected)  \(.status)"'
   ```

3. Clasifique la ruta de APISIX como «en migración», primero como desarrollador y luego como aprobador:

   ```bash
   F=$(consola luis.aprobador GET /discovery/findings | jq -r '.[] | select(.source == "apisix" and .path == "/fiscalizacion") | .id')
   consola_estado ana.desarrollo PATCH "/discovery/findings/$F" '{"status":"en_migracion"}'
   consola luis.aprobador PATCH "/discovery/findings/$F" '{"status":"en_migracion","note":"Se migrará a la plataforma"}' | jq '{path, status}'
   ```

4. Escanee de nuevo y descargue el reporte:

   ```bash
   S=$(consola carla.operacion POST /discovery/scans '{"sources":["apisix","nginx","red"]}' | jq -r .id)
   while [ "$(consola carla.operacion GET /discovery/scans | jq -r --arg s "$S" '.[] | select(.id == $s) | .status')" = "en_curso" ]; do sleep 3; done
   consola carla.operacion GET /discovery/scans | jq --arg s "$S" '.[] | select(.id == $s) | .totals'
   consola luis.aprobador GET /discovery/findings | jq -r --arg f "$F" '.[] | select(.id == $f) | .status'
   mkdir -p out && curl -s -H "Authorization: Bearer $(tok luis.aprobador)" "$CONSOLA/discovery/report?format=pdf" -o out/reporte-exposicion.pdf
   head -c 5 out/reporte-exposicion.pdf; echo
   ```

**Resultado esperado.** El escaneo termina (`terminado`) con hallazgos de APISIX, NGINX y la red. Entre los de mayor puntaje está el reporte de titulares del NGINX heredado (`/interno/reportes/titulares`), sin autenticación, con datos personales y puntaje de 90 o más. También aparecen la ruta `/fiscalizacion` de APISIX (autenticación requerida, no gobernada), la API de espectro que publica su contrato OpenAPI y el backend de Concesiones accesible sin pasar por el gateway. El desarrollador recibe `403` al clasificar; el aprobador deja el hallazgo `en_migracion` y el segundo escaneo lo conserva así, sin hallazgos nuevos (`totals.nuevos` en 0). El reporte es un PDF (empieza con `%PDF-`). La verificación `check:d01` automatiza estas comprobaciones.

**Autoevaluación.**

- ¿Por qué un backend que sí está en el catálogo aparece como hallazgo?

<details>
<summary>Respuesta</summary>

Porque responde directamente en la red, sin pasar por el gateway: quien llega así se salta la autenticación, los límites y la auditoría de la plataforma. El hallazgo lo asocia a su API y explica el motivo.

</details>
