-- Usuarios sintéticos de prueba. En Supabase se crean con Auth (panel o API de
-- administración); aquí se insertan directo en el stub de auth.users. Son las mismas
-- cuentas que la semilla vincula por correo si existen.
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'reportante.demo@cliente.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'contraparte.demo@cliente.invalid'),
  ('00000000-0000-4000-8000-000000000011', 'agente1.demo@yago.invalid'),
  ('00000000-0000-4000-8000-000000000012', 'agente2.demo@yago.invalid'),
  ('00000000-0000-4000-8000-000000000013', 'supervisor.demo@yago.invalid'),
  -- Cuentas que solo usan las pruebas (otra organización y una persona sin membresía).
  ('00000000-0000-4000-8000-000000000021', 'reportante@otra-org.invalid'),
  ('00000000-0000-4000-8000-000000000099', 'sin.membresia@ejemplo.invalid')
on conflict (id) do nothing;
