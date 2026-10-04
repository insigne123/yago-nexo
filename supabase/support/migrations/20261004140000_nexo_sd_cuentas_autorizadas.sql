-- Mesa de soporte Nexo · cuentas autorizadas (proyecto Supabase compartido).
--
-- En el proyecto compartido, el trigger de auth.users de la otra aplicación (public.crear_persona) rechaza
-- toda cuenta cuyo correo no esté autorizado en esa aplicación. Con autorización de Yago, ese trigger tiene
-- una excepción (supabase/support/compartido/excepcion_crear_persona.sql) que deja pasar los correos de esta
-- lista. Solo el rol de servicio (administradores de la mesa) puede escribirla: un registro público no puede
-- autorizarse a sí mismo.
--
-- Alta de una cuenta de la mesa: 1) insertar el correo aquí; 2) crear la cuenta en Supabase Auth;
-- 3) agregar su membresía en nexo_sd_memberships.

create table if not exists nexo_private.sd_cuentas_autorizadas (
  correo         text primary key check (correo = lower(correo) and position('@' in correo) > 1),
  motivo         text not null default 'cuenta de la mesa de soporte Nexo',
  autorizado_por text not null default current_user,
  creado_en      timestamptz not null default now()
);

alter table nexo_private.sd_cuentas_autorizadas enable row level security;
revoke all on nexo_private.sd_cuentas_autorizadas from public, anon, authenticated;

comment on table nexo_private.sd_cuentas_autorizadas is
  'Correos autorizados para tener cuenta en la mesa de soporte Nexo; los lee la excepción de public.crear_persona en el proyecto compartido.';
