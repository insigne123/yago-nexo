#!/bin/sh
# Sitio CPD (primario): rol de replicación, ranura y una tabla de estado para medir el RPO. Solo laboratorio.
set -eu
cat >> "$PGDATA/pg_hba.conf" <<HBA
host replication repl all scram-sha-256
HBA
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE repl WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}';
SELECT pg_create_physical_replication_slot('gcp_slot');
CREATE TABLE estado_plataforma (clave text PRIMARY KEY, valor text NOT NULL, actualizado timestamptz NOT NULL DEFAULT now());
INSERT INTO estado_plataforma (clave, valor) VALUES ('sitio_primario', 'cpd');
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -c "SELECT pg_reload_conf()"
