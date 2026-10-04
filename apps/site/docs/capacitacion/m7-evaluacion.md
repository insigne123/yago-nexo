---
title: "M7 · Repaso, evaluación práctica y examen de certificación"
sidebar_label: "M7 · Repaso y evaluación"
description: Módulo M7 de la capacitación de Yago Nexo (5 horas). Repaso, examen teórico de 40 preguntas, evaluación práctica en el laboratorio propio y entrega de evidencias.
---

# M7 · Repaso, evaluación práctica y examen de certificación

**Duración:** 5 horas · **Sesión:** 8 · **Rutas:** todas (el examen y la evaluación práctica son de la ruta de certificación)

## Objetivos de aprendizaje

Al terminar el módulo, el participante:

1. Repasa los puntos clave de su ruta y resuelve sus dudas con el laboratorio.
2. Deja su laboratorio en un estado conocido y graba la evidencia de su trabajo.
3. En la ruta de certificación: rinde el examen teórico y la evaluación práctica.

## Agenda

| Bloque | Tiempo | Ruta de certificación | Rutas por rol |
| --- | --- | --- | --- |
| 1 | 0:00 – 0:45 | Repaso guiado por módulo: autoevaluaciones y dudas. [Ejercicio 7.3](#ejercicio-7-3) (ensayo del teórico). | Igual. |
| 2 | 0:45 – 1:00 | Preparación: el evaluador restablece cada laboratorio (`make clean` y `make up`) para que arranque durante el examen teórico. | Ejercicios de repaso de la ruta. |
| 3 | 1:00 – 2:00 | **Examen teórico** (60 minutos). | Ejercicios de repaso de la ruta. |
| — | 2:00 – 2:15 | Pausa. | Pausa. |
| 4 | 2:15 – 4:45 | **Evaluación práctica** (150 minutos), en el laboratorio propio. | Ejercicios de repaso de la ruta y cierre a las 4:00. |
| 5 | 4:45 – 5:00 | Entrega de evidencias, encuesta y cierre. | — |

## Conceptos

### Examen teórico

- **40 preguntas** de selección única (una alternativa correcta entre cuatro), sorteadas de un banco con preguntas de M0 a M6.
- **Equilibrado por módulo**: entre 5 y 6 preguntas por módulo, con preguntas de dificultad baja, media y alta en cada uno.
- Cada participante recibe un examen sorteado con su propia semilla: el orden de las preguntas y de las alternativas cambia.
- **60 minutos**, sin consultar material ni el laboratorio. Una pregunta sin responder cuenta como incorrecta.
- Se aprueba con **al menos 70 %**: 28 de 40.

### Evaluación práctica

Cinco tareas en el laboratorio propio, con la documentación del curso abierta. Cada tarea vale 20 puntos; se aprueba con **al menos 70 puntos** y con la tarea P1 aprobada (las demás dependen de ella).

| Tarea | Módulos | Tiempo | Qué se pide | Cómo se verifica |
| --- | --- | --- | --- | --- |
| P1 · Preparar y comprobar el laboratorio | M0, M1 | 35 min | Arranque, plataforma como código, APIs en las etapas, plataforma existente simulada. | `make bootstrap` (200 y 401), `check:audiencias`, `nexo-ctl api list -s prod`. |
| P2 · Gobierno de contratos, promoción y reversa | M3 | 30 min | Corregir un contrato hasta 0 errores y 0 advertencias, desplegar y revertir en desarrollo, exportar con manifiesto. | `nexo-ctl api lint`, salida de la reversa, suma SHA-256 contra el manifiesto, `check:d07`. |
| P3 · Integración: idempotencia, falla y reproceso | M4 | 30 min | 202, 200 idempotente y 422; mensaje a la cola de fallidos; reproceso autorizado con motivo. | `check:integracion`, auditoría `mensajes.reprocesar`, estado del mensaje, `check:consola`. |
| P4 · Roles, cuatro ojos y bloqueo | M2, M5 | 30 min | 200 y 403 por rol; regla con aprobación; bloqueo aprobado, comprobado y liberado. | Auditoría de la regla, la aprobación y la liberación; cadena íntegra; `check:d02`. |
| P5 · Operación: severidad, simulacro y SIEM | M6 | 25 min | Clasificar un caso, simulacro de conmutación, interpretar la conmutación y la entrega al SIEM. | Auditoría `continuidad.simulacro`, `check:d05`, `check:siem`. |

El enunciado completo de cada tarea (preparación, entregables y criterios) lo entrega el evaluador al inicio del práctico.

### Evidencia

La terminal se graba desde el inicio del práctico:

```bash
script -q -f practico-$(date +%F).log
# … trabajo de la evaluación …
exit      # termina la grabación
```

El archivo de la grabación, más los archivos que pide cada tarea, es la evidencia con que el evaluador decide. Las verificaciones automáticas (`check:…`) las corre el evaluador al final de cada tarea, porque algunas cambian el estado del laboratorio.

### Corrección y resultados

El evaluador corrige el teórico y registra el resultado de cada tarea práctica en la hoja de respuestas; la herramienta de certificación de Yago calcula el resultado: **aprobado** si el teórico tiene al menos 70 % **y** el práctico está aprobado. Las reglas, la vigencia y la verificación de certificados están en [Certificación](./certificacion.md).

## Ejercicios de repaso

### Ejercicio 7.1 · Ensayo de la preparación contra reloj {#ejercicio-7-1}

**Objetivo.** Asegurar que la tarea P1 cabe en 35 minutos. Se recomienda hacerlo antes de la sesión 8.

**Pasos.**

1. Restablezca el laboratorio y levántelo (fuera del tiempo del ensayo, porque incluye el arranque de API Manager):

   ```bash
   make -C deploy/compose clean PROFILES="--profile obs --profile legacy --profile cont"
   make -C deploy/compose up
   make -C deploy/compose status      # hasta ver apim y keycloak sanos
   ```

2. Tome el tiempo y haga los pasos 4 y 5 de la [preparación](./laboratorio-participante.md#preparacion), sin mirar la guía si puede.
3. Compruebe con `pnpm --filter @nexo/lab-bootstrap check:audiencias` y `nexo-ctl api list -s prod`.

**Resultado esperado.** El arranque termina con la prueba de punta a punta (200 y 401), las cinco APIs aparecen `PUBLISHED`, `check:audiencias` termina con «verificado: cada audiencia recibe solo sus APIs», en menos de 35 minutos.

**Autoevaluación.**

- ¿En qué orden van `make bootstrap`, `make platform` y `make deploy-apis`, y por qué?

<details>
<summary>Respuesta</summary>

Primero el arranque, porque registra Keycloak como Key Manager, que las APIs necesitan; luego la plataforma, porque crea los ambientes de gateway (Desarrollo, QA, Operadores y Publico) donde se despliegan; al final los despliegues por etapa.

</details>

### Ejercicio 7.2 · Grabar la evidencia {#ejercicio-7-2}

**Objetivo.** Practicar la grabación de la terminal que se usa como evidencia.

**Pasos.**

1. Grabe una sesión corta:

   ```bash
   script -q -f ensayo.log
   source tools/lab-bootstrap/ayudas-curso.sh
   consola pedro.auditoria GET /audit-events/verify | jq '{ok, count}'
   exit
   ```

2. Revise el archivo: `less -R ensayo.log`.

**Resultado esperado.** `ensayo.log` contiene los comandos y sus salidas, en el orden en que se ejecutaron.

**Autoevaluación.**

- ¿Por qué las verificaciones automáticas las corre el evaluador al final de cada tarea y no el participante a mitad de ella?

<details>
<summary>Respuesta</summary>

Porque algunas cambian el estado del laboratorio: aprueban solicitudes pendientes, desactivan reglas, detienen servicios o provocan mensajes fallidos. Corridas a mitad de una tarea alterarían lo que se está evaluando.

</details>

### Ejercicio 7.3 · Ensayo del examen teórico {#ejercicio-7-3}

**Objetivo.** Conocer el formato del examen y repasar con las justificaciones de cada respuesta.

**Pasos.**

1. El instructor sortea un examen de ensayo con una semilla distinta de las del examen real y entrega el enunciado.
2. Responda en 20 minutos las preguntas que indique el instructor, en la hoja de respuestas.
3. El instructor corrige con la herramienta de certificación y revisa con el grupo la justificación de cada respuesta.

**Resultado esperado.** Cada participante conoce su resultado por módulo y las justificaciones de las preguntas que falló.

**Autoevaluación.**

- ¿Cuántas respuestas correctas se necesitan para aprobar el teórico?

<details>
<summary>Respuesta</summary>

28 de 40 (70 %).

</details>
