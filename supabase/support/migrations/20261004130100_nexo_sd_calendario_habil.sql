-- =============================================================================
-- Mesa de soporte Nexo · 02 · Calendario hábil y feriados
--
-- Calendario hábil: lunes a viernes, 09:00 a 18:00 en America/Santiago (configurable en
-- nexo_sd_settings), sin feriados nacionales. Los cambios de horario de verano en Chile
-- ocurren la noche del sábado al domingo, fuera de la jornada hábil, así que la aritmética
-- sobre hora local es exacta dentro de cada jornada.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Feriados nacionales 2026 y 2027 (Ley 2.977 y leyes posteriores). Revisados contra
-- feriados.cl y la Ley 19.668 (traslado al lunes de San Pedro y San Pablo y Encuentro de
-- Dos Mundos), la Ley 20.299 (Iglesias Evangélicas) y la Ley 20.983 (viernes 17 de
-- septiembre cuando el 18 y 19 caen sábado y domingo, como en 2027). Los feriados
-- regionales (7 de junio en Arica, 20 de agosto en Chillán) no se incluyen. Para años
-- siguientes se agregan filas: el cálculo no tiene fechas fijas en el código.
-- -----------------------------------------------------------------------------
insert into public.nexo_sd_holidays (day, name, irrenunciable, legal_basis) values
  ('2026-01-01', 'Año Nuevo', true, 'Ley 2.977; Ley 19.973'),
  ('2026-04-03', 'Viernes Santo', false, 'Ley 2.977'),
  ('2026-04-04', 'Sábado Santo', false, 'Ley 2.977'),
  ('2026-05-01', 'Día Nacional del Trabajo', true, 'Código del Trabajo; Ley 19.973'),
  ('2026-05-21', 'Día de las Glorias Navales', false, 'Ley 2.977'),
  ('2026-06-21', 'Día Nacional de los Pueblos Indígenas', false, 'Ley 21.357'),
  ('2026-06-29', 'San Pedro y San Pablo', false, 'Ley 2.977; Ley 19.668'),
  ('2026-07-16', 'Día de la Virgen del Carmen', false, 'Ley 20.148'),
  ('2026-08-15', 'Asunción de la Virgen', false, 'Ley 2.977'),
  ('2026-09-18', 'Independencia Nacional', true, 'Ley 2.977; Ley 19.973'),
  ('2026-09-19', 'Día de las Glorias del Ejército', true, 'Ley 2.977; Ley 20.629'),
  ('2026-10-12', 'Encuentro de Dos Mundos', false, 'Ley 3.810; Ley 19.668'),
  ('2026-10-31', 'Día Nacional de las Iglesias Evangélicas y Protestantes', false, 'Ley 20.299'),
  ('2026-11-01', 'Día de Todos los Santos', false, 'Ley 2.977'),
  ('2026-12-08', 'Inmaculada Concepción', false, 'Ley 2.977'),
  ('2026-12-25', 'Navidad', true, 'Ley 2.977; Ley 19.973'),
  ('2027-01-01', 'Año Nuevo', true, 'Ley 2.977; Ley 19.973'),
  ('2027-03-26', 'Viernes Santo', false, 'Ley 2.977'),
  ('2027-03-27', 'Sábado Santo', false, 'Ley 2.977'),
  ('2027-05-01', 'Día Nacional del Trabajo', true, 'Código del Trabajo; Ley 19.973'),
  ('2027-05-21', 'Día de las Glorias Navales', false, 'Ley 2.977'),
  ('2027-06-21', 'Día Nacional de los Pueblos Indígenas', false, 'Ley 21.357'),
  ('2027-06-28', 'San Pedro y San Pablo (se traslada desde el martes 29)', false, 'Ley 2.977; Ley 19.668'),
  ('2027-07-16', 'Día de la Virgen del Carmen', false, 'Ley 20.148'),
  ('2027-08-15', 'Asunción de la Virgen', false, 'Ley 2.977'),
  ('2027-09-17', 'Feriado adicional de Fiestas Patrias', false, 'Ley 20.983'),
  ('2027-09-18', 'Independencia Nacional', true, 'Ley 2.977; Ley 19.973'),
  ('2027-09-19', 'Día de las Glorias del Ejército', true, 'Ley 2.977; Ley 20.629'),
  ('2027-10-11', 'Encuentro de Dos Mundos (se traslada desde el martes 12)', false, 'Ley 3.810; Ley 19.668'),
  ('2027-10-31', 'Día Nacional de las Iglesias Evangélicas y Protestantes', false, 'Ley 20.299'),
  ('2027-11-01', 'Día de Todos los Santos', false, 'Ley 2.977'),
  ('2027-12-08', 'Inmaculada Concepción', false, 'Ley 2.977'),
  ('2027-12-25', 'Navidad', true, 'Ley 2.977; Ley 19.973')
on conflict (day) do nothing;

-- -----------------------------------------------------------------------------
-- Configuración vigente. SECURITY DEFINER porque la usan los triggers y la aritmética
-- de plazos con cualquier rol que llame: el resultado no puede depender de la RLS de
-- quien consulta (devolvería plazos distintos para distintos usuarios).
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_settings()
returns public.nexo_sd_settings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.nexo_sd_settings;
begin
  select s.* into v_row from public.nexo_sd_settings s where s.id;
  if not found then
    raise exception 'nexo_sd: falta la fila de configuración en public.nexo_sd_settings';
  end if;
  return v_row;
end;
$$;

create or replace function nexo_private.sd_is_business_day(p_day date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select extract(isodow from p_day)::int = any (s.business_isodows)
     and not exists (select 1 from public.nexo_sd_holidays h where h.day = p_day)
  from public.nexo_sd_settings s
  where s.id
$$;

-- -----------------------------------------------------------------------------
-- Suma minutos hábiles a un instante. Si el instante está fuera de la jornada, el
-- conteo empieza al inicio de la jornada hábil siguiente. Un plazo que se cumple
-- justo al cierre devuelve las 18:00 del mismo día (no las 09:00 del siguiente).
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_add_business_minutes(p_ts timestamptz, p_minutes numeric)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg       public.nexo_sd_settings;
  v_local     timestamp;
  v_day       date;
  v_day_start timestamp;
  v_day_end   timestamp;
  v_remaining numeric;
  v_available numeric;
  v_guard     int := 0;
begin
  if p_ts is null or p_minutes is null then
    return null;
  end if;
  if p_minutes <= 0 then
    return p_ts;
  end if;

  v_cfg := nexo_private.sd_settings();
  v_remaining := p_minutes * 60;
  v_local := p_ts at time zone v_cfg.timezone;

  loop
    v_guard := v_guard + 1;
    if v_guard > 5000 then
      raise exception 'nexo_sd: el calendario hábil no tiene días hábiles suficientes';
    end if;

    v_day := v_local::date;
    v_day_start := v_day + v_cfg.business_start;
    v_day_end := v_day + v_cfg.business_end;

    if v_local < v_day_end
       and extract(isodow from v_day)::int = any (v_cfg.business_isodows)
       and not exists (select 1 from public.nexo_sd_holidays h where h.day = v_day) then
      if v_local < v_day_start then
        v_local := v_day_start;
      end if;
      v_available := extract(epoch from (v_day_end - v_local));
      if v_remaining <= v_available then
        return (v_local + make_interval(secs => v_remaining::double precision)) at time zone v_cfg.timezone;
      end if;
      v_remaining := v_remaining - v_available;
    end if;

    v_local := (v_day + 1) + v_cfg.business_start;
  end loop;
end;
$$;
comment on function nexo_private.sd_add_business_minutes(timestamptz, numeric) is
  'Suma minutos hábiles (lun-vie 09:00-18:00 America/Santiago, sin feriados de nexo_sd_holidays).';

-- -----------------------------------------------------------------------------
-- Segundos hábiles entre dos instantes (0 si el intervalo es vacío o negativo).
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_business_seconds_between(p_from timestamptz, p_to timestamptz)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg   public.nexo_sd_settings;
  v_from  timestamp;
  v_to    timestamp;
  v_day   date;
  v_last  date;
  v_s     timestamp;
  v_e     timestamp;
  v_total numeric := 0;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    return 0;
  end if;

  v_cfg := nexo_private.sd_settings();
  v_from := p_from at time zone v_cfg.timezone;
  v_to := p_to at time zone v_cfg.timezone;
  v_day := v_from::date;
  v_last := v_to::date;

  while v_day <= v_last loop
    if extract(isodow from v_day)::int = any (v_cfg.business_isodows)
       and not exists (select 1 from public.nexo_sd_holidays h where h.day = v_day) then
      v_s := greatest(v_from, v_day + v_cfg.business_start);
      v_e := least(v_to, v_day + v_cfg.business_end);
      if v_e > v_s then
        v_total := v_total + extract(epoch from (v_e - v_s));
      end if;
    end if;
    v_day := v_day + 1;
  end loop;

  return v_total;
end;
$$;

create or replace function nexo_private.sd_business_minutes_between(p_from timestamptz, p_to timestamptz)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select nexo_private.sd_business_seconds_between(p_from, p_to) / 60.0
$$;

-- -----------------------------------------------------------------------------
-- Operaciones según el calendario del reloj: '24x7' (corrido) o 'habil'.
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_calendar_seconds(p_calendar text, p_from timestamptz, p_to timestamptz)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to <= p_from then
    return 0;
  end if;
  if p_calendar = '24x7' then
    return extract(epoch from (p_to - p_from));
  elsif p_calendar = 'habil' then
    return nexo_private.sd_business_seconds_between(p_from, p_to);
  end if;
  raise exception 'nexo_sd: calendario desconocido %', p_calendar;
end;
$$;

create or replace function nexo_private.sd_calendar_add(p_calendar text, p_ts timestamptz, p_seconds numeric)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_ts is null or p_seconds is null then
    return null;
  end if;
  if p_calendar = '24x7' then
    return p_ts + make_interval(secs => greatest(p_seconds, 0)::double precision);
  elsif p_calendar = 'habil' then
    return nexo_private.sd_add_business_minutes(p_ts, p_seconds / 60.0);
  end if;
  raise exception 'nexo_sd: calendario desconocido %', p_calendar;
end;
$$;
