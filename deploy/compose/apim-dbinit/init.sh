#!/bin/sh
set -eu
export PGPASSWORD="$APIM_DB_PASSWORD"
until pg_isready -h postgres -U apimadmin -d apim_db >/dev/null 2>&1; do echo "esperando PostgreSQL..."; sleep 2; done
apply() {
  db="$1"; marker="$2"; script="$3"
  if psql -h postgres -U apimadmin -d "$db" -tAc "SELECT to_regclass('$marker')" | grep -q "$marker"; then
    echo "[$db] esquema ya existe ($marker)"
  else
    echo "[$db] aplicando $script"
    psql -h postgres -U apimadmin -d "$db" -v ON_ERROR_STOP=1 -q -f "$script"
  fi
}
apply shared_db "reg_resource" /dbscripts/shared_db.sql
apply apim_db "am_api" /dbscripts/apim_db.sql
echo "listo"
