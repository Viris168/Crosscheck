#!/usr/bin/env bash
# Nightly Postgres backup of BOTH databases (`app`, `inngest`): pg_dump → gzip.
# Deliberately NOT backed up: the `repo-cache` volume (branch-tree clones). It is a cache, rebuilt by the
# next sync, and it holds commit objects that must never leave the server (docs/deploy.md → 3.9).
# Keeps 7 daily + 4 weekly (Sunday) copies; optional upload to S3-compatible storage.
#
#   infra/scripts/backup.sh                       # manual run
#   cron (bootstrap.sh installs it):  15 3 * * *  deploy  /opt/app/infra/scripts/backup.sh
#
# Env (optional, from $APP_DIR/backup.env — kept out of the app's .env so the web container never sees it):
#   BACKUP_DIR          default <app dir>/backups
#   KEEP_DAILY=7 KEEP_WEEKLY=4
#   S3_BUCKET           e.g. s3://my-bucket/ai-review   (unset = local only)
#   S3_ENDPOINT_URL     e.g. https://<account>.r2.cloudflarestorage.com, https://s3.eu-central-003.backblazeb2.com
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION (default auto)
set -euo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(dirname "$(dirname "$SCRIPTS")")}"
if [[ -f "$APP_DIR/backup.env" ]]; then set -a; . "$APP_DIR/backup.env"; set +a; fi
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
DATABASES=(app inngest)

log() { echo "[backup $(date -u +%FT%TZ)] $*"; }
compose() { "$SCRIPTS/compose.sh" "$@"; }

umask 077
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"
stamp="$(date -u +%Y%m%d-%H%M%S)"
made=()

for db in "${DATABASES[@]}"; do
  out="$BACKUP_DIR/daily/$db-$stamp.sql.gz"
  log "dumping $db"
  # Plain SQL with DROP/CREATE so restore.sh can replay it into a fresh database.
  if ! compose exec -T postgres pg_dump -U app --no-owner --no-privileges "$db" | gzip -9 > "$out.tmp"; then
    rm -f "$out.tmp"; log "pg_dump $db FAILED"; exit 1
  fi
  gzip -t "$out.tmp"
  mv "$out.tmp" "$out"
  made+=("$out")
  log "wrote $out ($(du -h "$out" | cut -f1))"
  if [[ "$(date -u +%u)" == 7 ]]; then cp "$out" "$BACKUP_DIR/weekly/"; fi
done

# Retention: newest N per database in each folder.
prune() { # dir keep
  for db in "${DATABASES[@]}"; do
    ls -1t "$1/$db-"*.sql.gz 2>/dev/null | tail -n +"$(($2 + 1))" | xargs -r rm -f --
  done
}
prune "$BACKUP_DIR/daily" "$KEEP_DAILY"
prune "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"

if [[ -n "${S3_BUCKET:-}" ]]; then
  log "uploading to $S3_BUCKET"
  for f in "${made[@]}"; do
    kind=daily; [[ "$(date -u +%u)" == 7 ]] && kind=weekly
    docker run --rm \
      -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}" \
      -v "$f:/backup/$(basename "$f"):ro" \
      amazon/aws-cli:2.31.0 s3 cp "/backup/$(basename "$f")" "$S3_BUCKET/$kind/$(basename "$f")" \
      ${S3_ENDPOINT_URL:+--endpoint-url "$S3_ENDPOINT_URL"} --only-show-errors
  done
  # Remote retention: use a lifecycle rule on the bucket (e.g. expire daily/ after 8 days, weekly/ after 35).
fi
log "done"
