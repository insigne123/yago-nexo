-- Aritmética de tiempo hábil: lun-vie 09:00-18:00 America/Santiago, sin feriados.
-- Referencias: 2026-10-02 es viernes, 2026-10-12 (lunes) es feriado, 2026-09-18 es viernes
-- feriado, 2026-04-03 es Viernes Santo y el 2026-04-05 termina el horario de verano.
begin;

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-10-05 10:00'), 60),
  nexo_test.cl('2026-10-05 11:00'),
  'suma 60 minutos dentro de la jornada');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-10-05 17:30'), 60),
  nexo_test.cl('2026-10-06 09:30'),
  'al cierre de la jornada continúa a las 09:00 del día hábil siguiente');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-10-02 17:00'), 120),
  nexo_test.cl('2026-10-05 10:00'),
  'cruza un fin de semana (viernes 17:00 + 2 h = lunes 10:00)');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-10-09 17:00'), 120),
  nexo_test.cl('2026-10-13 10:00'),
  'cruza fin de semana y el feriado del lunes 12-10 (Encuentro de Dos Mundos)');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-09-17 17:00'), 120),
  nexo_test.cl('2026-09-21 10:00'),
  'salta el 18 de septiembre (viernes, irrenunciable) y el fin de semana');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-04-02 17:00'), 120),
  nexo_test.cl('2026-04-06 10:00'),
  'salta Viernes Santo y el fin de semana del cambio de horario');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-04-02 17:00'), 120),
  '2026-04-06 14:00:00+00'::timestamptz,
  'el lunes 06-04 10:00 en Chile corresponde a 14:00 UTC (horario de invierno, UTC-4)');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-09-04 17:00'), 120),
  '2026-09-07 13:00:00+00'::timestamptz,
  'tras el inicio del horario de verano (06-09) el lunes 10:00 es 13:00 UTC (UTC-3)');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-10-03 10:00'), 60),
  nexo_test.cl('2026-10-05 10:00'),
  'un plazo que nace en sábado empieza a contar el lunes a las 09:00');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-10-05 07:00'), 30),
  nexo_test.cl('2026-10-05 09:30'),
  'antes de las 09:00 el conteo empieza al abrir la jornada');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-10-05 09:00'), 540),
  nexo_test.cl('2026-10-05 18:00'),
  'un día hábil completo termina a las 18:00 del mismo día');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-10-05 10:00'), 1620),
  nexo_test.cl('2026-10-08 10:00'),
  '3 días hábiles (1620 min) desde el lunes 10:00 vencen el jueves 10:00');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-10-05 10:00'), 5400),
  nexo_test.cl('2026-10-20 10:00'),
  '10 días hábiles (5400 min) saltan el feriado del 12-10 y vencen el martes 20-10');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2027-09-16 17:00'), 120),
  nexo_test.cl('2027-09-20 10:00'),
  '2027: viernes 17-09 es feriado (Ley 20.983) y el plazo pasa al lunes 20-09');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2027-06-25 17:00'), 120),
  nexo_test.cl('2027-06-29 10:00'),
  '2027: San Pedro y San Pablo se traslada al lunes 28-06');

select nexo_test.eq(
  nexo_private.sd_add_business_minutes(nexo_test.cl('2026-10-03 10:00'), 0),
  nexo_test.cl('2026-10-03 10:00'),
  'sumar cero minutos no mueve el instante');

select nexo_test.eq(
  nexo_private.sd_business_minutes_between(nexo_test.cl('2026-10-09 17:00'), nexo_test.cl('2026-10-13 10:00')),
  120::numeric,
  'minutos hábiles entre viernes 17:00 y martes 10:00 con feriado intermedio');

select nexo_test.eq(
  nexo_private.sd_business_minutes_between(nexo_test.cl('2026-10-03 00:00'), nexo_test.cl('2026-10-04 23:59')),
  0::numeric,
  'un fin de semana no tiene minutos hábiles');

select nexo_test.eq(
  nexo_private.sd_business_minutes_between(nexo_test.cl('2026-10-13 10:00'), nexo_test.cl('2026-10-09 17:00')),
  0::numeric,
  'un intervalo invertido mide cero');

select nexo_test.ok(
  (select bool_and(
     nexo_private.sd_business_minutes_between(
       nexo_test.cl('2026-10-08 16:15'),
       nexo_private.sd_add_business_minutes(nexo_test.cl('2026-10-08 16:15'), m)) = m)
   from unnest(array[1, 59, 105, 540, 1620, 5400]) as m),
  'sumar y medir minutos hábiles son operaciones inversas');

select nexo_test.eq(
  nexo_private.sd_calendar_add('24x7', nexo_test.cl('2026-10-03 23:00'), 3600),
  nexo_test.cl('2026-10-04 00:00'),
  'el calendario 24x7 suma tiempo corrido (incluye fines de semana)');

select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_holidays where day between '2026-01-01' and '2026-12-31'),
  16, 'hay 16 feriados nacionales en 2026');

select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_holidays where day between '2027-01-01' and '2027-12-31'),
  17, 'hay 17 feriados nacionales en 2027 (incluye el viernes 17-09)');

select nexo_test.ok(
  not exists (select 1 from public.nexo_sd_holidays h
              where h.day in ('2027-06-29', '2027-10-12')),
  'en 2027 los feriados trasladables quedan en lunes (28-06 y 11-10)');

rollback;
