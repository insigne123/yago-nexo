-- Definición ORIGINAL de public.crear_persona() en el proyecto Supabase compartido, tal como estaba el
-- 2026-10-04 antes de agregar la excepción de la mesa Nexo. Ejecutar este archivo revierte el cambio.

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
