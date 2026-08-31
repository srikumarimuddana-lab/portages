#!/usr/bin/env bash
#
# Runs the database half of the gate against a real PostgreSQL: every
# migration on an empty database, every SQL contract, then every
# down-migration in reverse.
#
# WHY THIS EXISTS. `pg` is not installable in this environment, so no test
# can open a connection and the unit suite runs entirely against a fake Sql.
# That fake proves what the services decide; it cannot prove that PostgreSQL
# behaves the way they assume. The gap was filled by test/sql/*.sql, which
# assert the database's own guarantees — partial unique indexes, append-only
# triggers, publish guards, query plans — but until now those only ran in CI,
# which means a contract could be written, be wrong, and stay wrong until a
# pull request opened.
#
# `psql` and a full PostgreSQL server ARE present, so the contracts can run
# here after all. The server is a throwaway: its own data directory under
# /tmp, its own port, a unix socket only, and it is stopped and deleted on
# exit whether the run passed or failed.
#
# This is the same sequence CI runs, in the same order, so a green run here
# means a green run there.
#
# Usage:  scripts/db-contracts.sh [--keep]
#         --keep  leave the server running afterwards, for poking at by hand.
# Exit:   0 everything held, non-zero on the first failure.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BACKEND="$ROOT/backend"
PORT=${PGCONTRACT_PORT:-5433}
SOCKDIR=${PGCONTRACT_SOCKDIR:-/tmp}
DB=portage_contracts
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "No PostgreSQL server found (looked in /usr/lib/postgresql/*/bin)." >&2
  echo "Install one, or run the contracts in CI." >&2
  exit 2
fi

# initdb refuses to run as root, so the server runs as an unprivileged user
# with a data directory in its own home. When we are not root, use our own.
if [ "$(id -u)" -eq 0 ]; then
  RUNAS=${PGCONTRACT_USER:-pgtest}
  id "$RUNAS" >/dev/null 2>&1 || useradd -m "$RUNAS"
  PGDATA=$(eval echo "~$RUNAS")/contracts-pgdata
  run_as() { su "$RUNAS" -c "$1"; }
else
  RUNAS=$(id -un)
  PGDATA="${TMPDIR:-/tmp}/contracts-pgdata-$$"
  run_as() { sh -c "$1"; }
fi

started=0
cleanup() {
  local code=$?
  if [ "$started" -eq 1 ] && [ "$KEEP" -eq 0 ]; then
    run_as "$PGBIN/pg_ctl -D $PGDATA -m immediate stop" >/dev/null 2>&1 || true
    rm -rf "$PGDATA"
  elif [ "$started" -eq 1 ]; then
    echo "Server left running: psql -h $SOCKDIR -p $PORT -U portage -d $DB"
  fi
  exit "$code"
}
trap cleanup EXIT

echo "── starting PostgreSQL ($(basename "$(dirname "$PGBIN")"))"
rm -rf "$PGDATA"
# Trust auth on a socket-only server owned by this run: there is no listening
# TCP port and nothing outside this machine can reach it.
run_as "$PGBIN/initdb -D $PGDATA -U portage --auth=trust" >/dev/null
run_as "$PGBIN/pg_ctl -D $PGDATA -o '-k $SOCKDIR -p $PORT -c listen_addresses=' -l $PGDATA/log -w start" >/dev/null
started=1

export PGHOST="$SOCKDIR" PGPORT="$PORT" PGUSER=portage
psql -d postgres -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" 2>/dev/null

cd "$BACKEND"

echo "── migrations, on an empty database"
for f in migrations/*.sql; do
  case "$f" in *.down.sql) continue;; esac
  printf '   %s\n' "$(basename "$f")"
  psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "── SQL contracts"
for f in test/sql/*.sql; do
  printf '   %s ... ' "$(basename "$f")"
  # Each contract prints its own pass line and rolls back, so they are
  # order-independent and re-runnable.
  psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -f "$f"
done

echo "── down-migrations, in reverse"
for f in $(ls -r migrations/*.down.sql 2>/dev/null); do
  printf '   %s\n' "$(basename "$f")"
  psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"
done

# 001–008 predate the down-migration convention and have no reverse, so the
# foundation tables are expected to remain. Everything a reversible migration
# CREATEd must be gone.
#
# The list is read out of the migrations rather than written here, so a new
# migration is covered the day it lands instead of the day someone remembers
# to add it. Note this checks only tables a migration created: one that merely
# ALTERs an older table (014 adds columns to `threads`) correctly leaves it
# standing, and hard-coding names got that wrong on the first attempt.
CREATED=$(sed -n 's/^CREATE TABLE \(IF NOT EXISTS \)\?\([a-z_][a-z0-9_]*\).*/\2/p' \
  $(ls migrations/*.sql | grep -v '\.down\.sql' | awk -F/ '$2 >= "009"') | sort -u)

LEFTOVER=""
for t in $CREATED; do
  n=$(psql -d "$DB" -tAc "SELECT count(*) FROM information_schema.tables
                           WHERE table_schema = 'public' AND table_name = '$t'")
  [ "$n" != "0" ] && LEFTOVER="$LEFTOVER $t"
done
if [ -n "$LEFTOVER" ]; then
  echo "FAIL: tables survived their down-migration:$LEFTOVER" >&2
  exit 1
fi
printf '   checked %s reversible tables\n' "$(echo "$CREATED" | wc -w)"

echo
echo "Database gate: migrations applied, contracts held, down-migrations reversed."
