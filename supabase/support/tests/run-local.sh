#!/usr/bin/env bash
# =============================================================================
# Pruebas locales de la base de datos de la Mesa de soporte Nexo.
#
# Levanta un PostgreSQL 16 desechable (sin Docker), aplica los stubs de Supabase, las
# migraciones (dos veces, para comprobar que se pueden reaplicar), la semilla y luego
# ejecuta cada supabase/support/tests/NN_*.sql. Al terminar detiene y borra el clúster.
#
# Uso:   supabase/support/tests/run-local.sh [patrón]     (p. ej. "03" para una sola prueba)
# Vars:  PG_BIN (por omisión /usr/lib/postgresql/16/bin), NEXO_TEST_PORT (55432),
#        KEEP_CLUSTER=1 para dejar el clúster arriba al terminar (depuración).
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${NEXO_TEST_PORT:-55432}"
FILTER="${1:-}"
DB="nexo_test"

for bin in initdb pg_ctl psql pg_isready; do
  if [[ ! -x "$PG_BIN/$bin" ]]; then
    echo "No se encontró $PG_BIN/$bin (defina PG_BIN)." >&2
    exit 2
  fi
done

if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "El puerto $PORT está ocupado; defina NEXO_TEST_PORT." >&2
  exit 2
fi

WORK="$(mktemp -d "${NEXO_TEST_TMPDIR:-/tmp}/nexo-sd-pg.XXXXXX")"
DATA="$WORK/data"
LOG="$WORK/postgres.log"

# initdb y postgres no corren como root: si somos root, se usa el usuario postgres.
if [[ "$(id -u)" -eq 0 ]]; then
  PG_USER="${PG_OS_USER:-postgres}"
  chown "$PG_USER" "$WORK"
  chmod 700 "$WORK"
  as_pg() { runuser -u "$PG_USER" -- "$@"; }
else
  as_pg() { "$@"; }
fi

cleanup() {
  local code=$?
  if [[ "${KEEP_CLUSTER:-0}" == "1" ]]; then
    echo "Clúster conservado en $WORK (puerto $PORT). Deténgalo con: $PG_BIN/pg_ctl -D $DATA stop"
    exit "$code"
  fi
  if [[ -f "$DATA/postmaster.pid" ]]; then
    as_pg "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT

echo "==> Creando clúster temporal en $WORK (puerto $PORT)"
as_pg "$PG_BIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --no-locale >"$WORK/initdb.log" 2>&1 || {
  cat "$WORK/initdb.log" >&2
  exit 1
}
as_pg "$PG_BIN/pg_ctl" -D "$DATA" -l "$LOG" -w \
  -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1 -c timezone=UTC -c fsync=off -c wal_level=logical" start >/dev/null || {
  cat "$LOG" >&2
  exit 1
}
for _ in $(seq 1 30); do
  "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PORT" -q && break
  sleep 0.5
done

PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres)
"${PSQL[@]}" -d postgres -c "create database $DB" >/dev/null

run_sql() {
  "${PSQL[@]}" -d "$DB" -1 -f "$1"
}

echo "==> Stubs de Supabase"
run_sql "$HERE/stubs/supabase_stubs.sql" >/dev/null

echo "==> Usuarios de prueba (equivalentes a cuentas creadas en Supabase Auth)"
run_sql "$HERE/lib/usuarios_prueba.sql" >/dev/null

shopt -s nullglob
MIGRATIONS=("$ROOT"/migrations/*.sql)
if [[ ${#MIGRATIONS[@]} -eq 0 ]]; then
  echo "No hay migraciones en $ROOT/migrations" >&2
  exit 1
fi

for pass in 1 2; do
  echo "==> Migraciones (pasada $pass de 2)"
  for f in "${MIGRATIONS[@]}"; do
    echo "    $(basename "$f")"
    run_sql "$f" >/dev/null 2>"$WORK/migration.err" || {
      cat "$WORK/migration.err" >&2
      exit 1
    }
    # Las advertencias esperadas (pg_cron/pg_net ausentes) se muestran sin detener la prueba.
    grep -E "WARNING|ADVERTENCIA" "$WORK/migration.err" | sed 's/^/      /' || true
  done
done

echo "==> Semilla"
run_sql "$ROOT/seed.sql" >/dev/null
run_sql "$ROOT/seed.sql" >/dev/null   # la semilla también se puede reaplicar

echo "==> Utilidades de prueba"
run_sql "$HERE/lib/helpers.sql" >/dev/null

TESTS=("$HERE"/[0-9][0-9]_*.sql)
passed_files=0
failed_files=0
assertions=0
for t in "${TESTS[@]}"; do
  name="$(basename "$t")"
  if [[ -n "$FILTER" && "$name" != *"$FILTER"* ]]; then
    continue
  fi
  out="$WORK/$name.out"
  fixture="$(cat "$HERE/fixtures/severity_matrix.json")"
  if "${PSQL[@]}" -d "$DB" -t -A -v "severity_matrix=$fixture" -f "$t" >"$out" 2>&1; then
    n=$(grep -c '^ok - ' "$out" || true)
    assertions=$((assertions + n))
    passed_files=$((passed_files + 1))
    printf '  PASA  %-40s %3d aserciones\n' "$name" "$n"
    if [[ "${VERBOSE:-0}" == "1" ]]; then sed 's/^/        /' "$out"; fi
  else
    failed_files=$((failed_files + 1))
    printf '  FALLA %s\n' "$name"
    sed 's/^/        /' "$out"
  fi
done

echo "==> Resultado: $passed_files archivos OK, $failed_files con fallas, $assertions aserciones"
if [[ $failed_files -gt 0 ]]; then
  exit 1
fi
