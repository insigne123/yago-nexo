-- Excepción en public.crear_persona() (trigger de auth.users de la otra aplicación del proyecto Supabase
-- compartido) para que las cuentas de la mesa de soporte Nexo puedan existir. Autorizado por Yago el 04-10-2026.
-- Requiere la migración 20261004140000_nexo_sd_cuentas_autorizadas.sql.
-- Cambia SOLO el inicio de la función; el resto queda idéntico al original (ver revertir_crear_persona.sql).
-- CREATE OR REPLACE conserva el dueño y los permisos de la función.
--
-- Nota: la marca en app_metadata no sirve aquí, porque Supabase Auth inserta la cuenta antes de escribir
-- app_metadata; por eso se usa una lista de correos autorizados, como hace la propia aplicación con su equipo.

CREATE OR REPLACE FUNCTION public.crear_persona()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_correo text := lower(new.email);
  v_rol public.rol_persona;
  v_org uuid;
begin
  -- Excepción para la mesa de soporte Nexo (proyecto compartido): los correos que un administrador de la mesa
  -- autorizó en nexo_private.sd_cuentas_autorizadas (solo el rol de servicio puede escribirla) no son personas
  -- de esta aplicación: se acepta la cuenta sin crear fila en public.personas.
  if exists (select 1 from nexo_private.sd_cuentas_autorizadas a where a.correo = v_correo) then
    return new;
  end if;
  select e.rol into v_rol from public.equipo e where e.correo = v_correo;
  if v_rol is not null then
    insert into public.personas (id, correo, rol) values (new.id, v_correo, v_rol);
    return new;
  end if;
  select o.id into v_org
    from public.organizaciones o
   where split_part(v_correo, '@', 2) = any (select lower(d) from unnest(o.dominios) d)
     and exists (select 1 from public.contratos c where c.organizacion_id = o.id and c.activo)
   order by o.creado
   limit 1;
  if v_org is null then
    raise exception 'El correo % no está autorizado para la mesa de ayuda', v_correo using errcode = '42501';
  end if;
  insert into public.personas (id, organizacion_id, correo, rol) values (new.id, v_org, v_correo, 'cliente');
  return new;
end;
$function$

;
