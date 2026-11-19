#!/usr/bin/env bash
# Restore Postgres from backup.sh dumps. DESTRUCTIVE: the target database is dropped and recreated.
#
#   infra/scripts/restore.sh app     backups/daily/app-20261119-031500.sql.gz
#   infra/scripts/restore.sh inngest backups/daily/inngest-20261119-031500.sql.gz
#   infra/scripts/restore.sh app latest                    # newest daily dump of that database
#   FORCE=1 infra/scripts/restore.sh ...                   # no confirmation prompt
#
# Stops web + inngest while restoring and starts them again afterwards.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(dirname "$(dirname "$SCRIPTS")")}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
compose() { "$SCRIPTS/compose.sh" "$@"; }
log() { echo "[restore $(date -u +%FT%TZ)] $*"; }

db="${1:?usage: restore.sh <app|inngest> <file.sql.gz|latest>}"
file="${2:?usage: restore.sh <app|inngest> <file.sql.gz|latest>}"
[[ "$db" == app || "$db" == inngest ]] || { echo "database must be app or inngest" >&2; exit 1; }
if [[ "$file" == latest ]]; then
  file="$(ls -1t "$BACKUP_DIR/daily/$db-"*.sql.gz 2>/dev/null | head -1 || true)"
  [[ -n "$file" ]] || { echo "no dumps for $db in $BACKUP_DIR/daily" >&2; exit 1; }
fi
[[ -f "$file" ]] || { echo "not found: $file" >&2; exit 1; }
gzip -t "$file"

if [[ "${FORCE:-}" != 1 ]]; then
  read -r -p "Drop database '$db' and restore it from $file? Type the database name to confirm: " answer
  [[ "$answer" == "$db" ]] || { echo "aborted"; exit 1; }
fi

log "stopping web + inngest"
compose stop web inngest

restart() { log "starting web + inngest"; compose up -d --no-build web inngest; }
trap restart EXIT

log "recreating database $db"
compose exec -T postgres dropdb -U app --if-exists --force "$db"
compose exec -T postgres createdb -U app -O app "$db"

log "loading $file"
gunzip -c "$file" | compose exec -T postgres psql -U app -d "$db" -v ON_ERROR_STOP=1 --quiet >/dev/null

log "restored $db"
