---
title: Certificación
sidebar_label: Certificación
description: Certificación Yago Nexo — Administrador/Integrador de la plataforma. Quién la emite, requisitos, formato de la evaluación, criterios de aprobación, vigencia y verificación de un certificado.
---

import Contacto from '@site/src/components/Contacto';
import VersionActual from '@site/src/components/VersionActual';

# Certificación Yago Nexo — Administrador/Integrador de la plataforma

La certificación acredita que una persona sabe **preparar, administrar, publicar, integrar, proteger y operar** la plataforma Yago Nexo: lo que se practica en los módulos M0 a M6 del [programa de capacitación](./index.md).

## Quién la emite {#emisor}

La emite **Sociedad de Inversiones Yago SpA**, como fabricante de la distribución Yago Nexo. Es una certificación sobre Yago Nexo, no sobre los componentes de terceros por separado: WSO2 es una marca de WSO2 LLC y Yago Nexo no está afiliado a WSO2 LLC (ver [Licencia y avisos](../licencia-y-avisos.md)).

## Requisitos {#requisitos}

1. Cursar la **ruta de certificación** completa (M0 a M7, 40 horas), con asistencia de al menos 80 % de las horas.
2. Tener el **laboratorio propio** operativo para la evaluación práctica (ver [Laboratorio del participante](./laboratorio-participante.md)).
3. Aprobar el **examen teórico** y la **evaluación práctica**, que se rinden en la sesión 8 ([M7](./m7-evaluacion.md)).

## Formato de la evaluación {#formato}

| Parte | Formato | Duración | Condiciones |
| --- | --- | --- | --- |
| Examen teórico | 40 preguntas de selección única (una alternativa correcta entre cuatro), sorteadas de un banco y equilibradas entre los módulos M0 a M6: entre 5 y 6 por módulo, con dificultad baja, media y alta. Cada participante recibe su propio sorteo. | 60 minutos | Sin material de consulta. Una pregunta sin responder cuenta como incorrecta. |
| Evaluación práctica | 5 tareas en el laboratorio propio: preparar y comprobar el laboratorio; gobierno de contratos, promoción y reversa; integración con idempotencia, falla y reproceso; roles, cuatro ojos y bloqueo de un consumidor; operación, simulacro de conmutación y SIEM. | 150 minutos | Con la documentación del curso. Trabajo individual. La terminal se graba como evidencia. |

Las preguntas tratan solo del comportamiento real de la versión del producto que se certifica. Cada tarea práctica se verifica con los scripts de verificación que trae el laboratorio y con la evidencia de la terminal.

## Criterios de aprobación {#aprobacion}

Se certifica quien cumple **las dos** condiciones; una parte no compensa a la otra:

| Parte | Para aprobar |
| --- | --- |
| Teórico | Al menos **70 %** de respuestas correctas (28 de 40). |
| Práctico | Al menos **70 de 100 puntos** (cada tarea vale 20) **y** la tarea P1 aprobada, porque las demás dependen del laboratorio preparado en ella. |

**Repetición.** Quien no aprueba puede repetir una vez la parte reprobada dentro de los 60 días siguientes. El examen teórico de la repetición se sortea de nuevo; la parte aprobada se conserva durante ese plazo.

**Integridad.** El banco de preguntas y la clave de cada examen son material reservado de Yago. Copiar, recibir ayuda de otra persona o alterar la evidencia significa reprobar la evaluación.

## El certificado {#certificado}

Quien aprueba recibe un certificado en PDF con:

- el nombre del programa: «Certificación Yago Nexo — Administrador/Integrador de la plataforma»;
- el nombre de la persona y su **documento de identidad** (RUT u otro documento);
- la **fecha de emisión** y la fecha hasta la que está vigente;
- la **versión del producto** certificada (hoy, <VersionActual formato="numero" />) y su versión mayor;
- la nota del examen teórico y el examen rendido;
- un **código único**, con la forma `YNX-<versión mayor>-<año>-XXXX-XXXX`;
- un **hash de verificación SHA-256**.

El código se deriva del documento de identidad, la fecha, la versión y el examen. El hash se calcula sobre todos los datos del certificado (programa, emisor, nombre, documento, fechas, versión, examen, nota, resultado práctico y código) en forma canónica: cambiar cualquier dato cambia el hash. El PDF incluye esos datos, para poder recalcularlo.

Yago conserva un registro de los certificados emitidos y usa sus datos solo para emitirlos y verificarlos.

## Vigencia {#vigencia}

- El certificado es válido por **2 años** desde su emisión, **para la versión mayor certificada**. Por ejemplo, un certificado emitido sobre la versión 1.0.0 cubre Yago Nexo 1.x durante dos años.
- Las versiones menores y los parches de esa misma versión mayor no requieren certificarse de nuevo.
- Una nueva versión mayor (por ejemplo, 2.0.0) trae cambios incompatibles: el certificado de 1.x no la cubre, y para ella hay que certificarse de nuevo.
- Para renovar al vencer, se rinden de nuevo el examen teórico y la evaluación práctica sobre la versión vigente.

## Cómo verificar un certificado {#verificar}

**Confirmación con Yago.** Escriba a <Contacto tipo="soporte" /> indicando el código del certificado. Yago lo busca en su registro de certificados emitidos y confirma a quién pertenece, la fecha de emisión, la versión y si está vigente. Es la verificación que vale ante terceros.

**Integridad del archivo.** La herramienta de certificación de Yago Nexo lee los datos incluidos en el PDF, recalcula el código y el hash y revisa la vigencia:

```bash
pnpm --filter @nexo/certificacion cert verificar --pdf certificado-YNX-1-2026-XXXX-XXXX.pdf
```

```text
Certificado YNX-1-2026-XXXX-XXXX
  Certificación Yago Nexo — Administrador/Integrador de la plataforma
  …
  Integridad: correcta (el código y el hash corresponden a los datos)
  Vigencia: vigente
```

Si el código o el hash no corresponden a los datos, la herramienta informa que el certificado fue alterado. Compare también el código y el hash impresos en el documento con los que muestra la herramienta.
