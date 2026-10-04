-- Clasificación determinista: nexo_private.sd_classify debe coincidir con classifySeverity
-- (packages/shared/src/severity.ts) en las 32 combinaciones. La matriz la genera y verifica
-- la prueba de Vitest de apps/support-web; run-local.sh la entrega en :severity_matrix.
begin;

create temp table matriz as select (:'severity_matrix')::jsonb as doc;
create temp table casos as
  select c ->'answers' as answers, c ->> 'severity' as severity, c ->> 'rule' as rule
  from matriz, jsonb_array_elements(matriz.doc -> 'casos') as c;

select nexo_test.eq((select count(*)::int from casos), 32, 'la matriz trae 32 casos');
select nexo_test.eq((select count(distinct answers)::int from casos), 32, 'los 32 casos son combinaciones distintas');

select nexo_test.eq(
  (select count(*)::int
   from casos k
   cross join lateral nexo_private.sd_classify(
     (k.answers ->> 'esConsultaOCambio')::boolean,
     (k.answers ->> 'servicioProductivoCaido')::boolean,
     (k.answers ->> 'existeAlternativa')::boolean,
     (k.answers ->> 'degradacionOSeguridad')::boolean,
     (k.answers ->> 'soloNoProductivoOMenor')::boolean) r
   where r.severity = k.severity and r.rule = k.rule),
  32, 'sd_classify coincide con classifySeverity (severidad y regla) en las 32 combinaciones');

select nexo_test.eq(
  (select count(*)::int
   from casos k
   cross join lateral nexo_private.sd_classify_answers(k.answers) r
   where r.severity = k.severity and r.rule = k.rule),
  32, 'sd_classify_answers (JSON del ticket) coincide en las 32 combinaciones');

select nexo_test.throws(
  $$select nexo_private.sd_classify_answers('{"esConsultaOCambio": false}'::jsonb)$$,
  'faltan respuestas: error', '22023');
select nexo_test.throws(
  $$select nexo_private.sd_classify_answers('{"esConsultaOCambio": "no", "servicioProductivoCaido": false, "existeAlternativa": false, "degradacionOSeguridad": false, "soloNoProductivoOMenor": false}'::jsonb)$$,
  'una respuesta que no es booleana: error', '22023');
select nexo_test.throws(
  $$select nexo_private.sd_classify_answers('{"esConsultaOCambio": false, "servicioProductivoCaido": false, "existeAlternativa": false, "degradacionOSeguridad": false, "soloNoProductivoOMenor": false, "severidad": "S1"}'::jsonb)$$,
  'una clave extra (intento de fijar la severidad): error', '22023');
select nexo_test.throws(
  $$select nexo_private.sd_classify(null, false, false, false, false)$$,
  'respuestas nulas: error', '22023');

-- La severidad del ticket sale de las respuestas aunque el cliente envíe otra.
select nexo_test.login('reportante.demo@subtel.invalid');
insert into public.nexo_sd_tickets (org_id, title, description, classification_answers)
values (nexo_test.org('subtel-demo'), 'Prueba de clasificación', 'Todo caído',
        '{"esConsultaOCambio": false, "servicioProductivoCaido": true, "existeAlternativa": false, "degradacionOSeguridad": false, "soloNoProductivoOMenor": false}');
select nexo_test.eq(
  (select t.severity || ' / ' || t.classification_rule from public.nexo_sd_tickets t where t.title = 'Prueba de clasificación'),
  'S1 / Servicio productivo caído y sin alternativa operativa',
  'el ticket web toma severidad y regla del asistente');
select nexo_test.throws(
  $$insert into public.nexo_sd_tickets (org_id, title, description, severity, classification_answers)
    values (nexo_test.org('subtel-demo'), 'Intento', 'x', 'S1', '{"esConsultaOCambio": true, "servicioProductivoCaido": false, "existeAlternativa": false, "degradacionOSeguridad": false, "soloNoProductivoOMenor": false}')$$,
  'la API no puede escribir la columna severity', '42501');
select nexo_test.throws(
  $$insert into public.nexo_sd_tickets (org_id, title, description) values (nexo_test.org('subtel-demo'), 'Sin asistente', 'x')$$,
  'un ticket web sin respuestas del asistente se rechaza', '23514');
reset role;

rollback;
