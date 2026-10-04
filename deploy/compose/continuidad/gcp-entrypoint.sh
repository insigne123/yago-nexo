#!/bin/sh
# Sitio GCP (respaldo): en el primer arranque clona el primario con pg_basebackup y queda como réplica en
# espera (standby.signal + primary_conninfo, por la opción -R). Luego se comporta como un PostgreSQL normal.
set -eu
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[gcp] esperando al primario cont-cpd…"
  until pg_isready -h cont-cpd -p 5432 -U repl >/dev/null 2>&1; do sleep 1; done
  echo "[gcp] clonando el primario (pg_basebackup)…"
  PGPASSWORD="$REPL_PASSWORD" pg_basebackup -h cont-cpd -p 5432 -U repl -D "$PGDATA" -R -S gcp_slot -X stream -w
  chmod 700 "$PGDATA"
  echo "[gcp] réplica lista, en espera"
fi
exec docker-entrypoint.sh postgres
