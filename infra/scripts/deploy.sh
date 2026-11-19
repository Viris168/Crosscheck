#!/usr/bin/env bash
# Deploy a web image tag; roll back to the previous tag if it doesn't come up healthy.
# Run on the server (deploy.yml does this over SSH):
#
#   WEB_IMAGE=ghcr.io/owner/repo-web infra/scripts/deploy.sh sha-<commit>
#   infra/scripts/deploy.sh --rollback          # back to the previous tag
#
# Migrations run (one-shot `migrate`) before `web` starts. They are NOT rolled back: keep them
# backward compatible (expand → deploy → contract), and take a backup before risky ones.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPTS")"
APP_DIR="${APP_DIR:-$(dirname "$INFRA_DIR")}"
export STATE_DIR="${STATE_DIR:-$APP_DIR/.deploy}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
mkdir -p "$STATE_DIR"

compose() { "$SCRIPTS/compose.sh" "$@"; }
log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

if [[ "${1:-}" == "--rollback" ]]; then
  TAG="$(cat "$STATE_DIR/previous_tag" 2>/dev/null || true)"
  [[ -n "$TAG" ]] || { echo "no previous tag recorded in $STATE_DIR" >&2; exit 1; }
else
  TAG="${1:?usage: deploy.sh <image-tag> | --rollback}"
fi
if [[ -n "${WEB_IMAGE:-}" ]]; then echo "$WEB_IMAGE" > "$STATE_DIR/web_image"; fi
export WEB_IMAGE="${WEB_IMAGE:-$(cat "$STATE_DIR/web_image" 2>/dev/null || echo ai-review-web)}"
PREV="$(cat "$STATE_DIR/current_tag" 2>/dev/null || true)"

ENV_FILE="${APP_ENV_FILE:-$APP_DIR/.env}"
DOMAIN="$(sed -n 's/^DOMAIN=\([^ #]*\).*/\1/p' "$ENV_FILE" | tail -1 | tr -d "\"'")"
HTTPS_PORT="$(sed -n 's/^HTTPS_PORT=\([0-9]*\).*/\1/p' "$ENV_FILE" | tail -1)"
HTTPS_PORT="${HTTPS_PORT:-443}"

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) id status=unknown
  while ((SECONDS < deadline)); do
    id="$(compose ps -q web)"
    status="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)"
    # Container healthcheck, then end to end through Caddy
    # (-k: on a first deploy the certificate may still be being issued).
    if [[ "$status" == "healthy" ]] && curl -fsSk --max-time 5 \
      --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" "https://$DOMAIN:$HTTPS_PORT/api/health" >/dev/null; then
      return 0
    fi
    sleep 5
  done
  log "web did not become healthy within ${HEALTH_TIMEOUT}s (last status: $status)"
  compose logs --tail 50 web migrate >&2 || true
  return 1
}

up_tag() {
  local tag="$1"
  export WEB_TAG="$tag"
  log "pulling $WEB_IMAGE:$tag"
  if [[ "${SKIP_PULL:-}" != 1 ]]; then compose pull --quiet web; fi
  log "migrate + start"
  compose up -d --no-build --remove-orphans
}

up_tag "$TAG"
if wait_healthy; then
  if [[ -n "$PREV" && "$PREV" != "$TAG" ]]; then echo "$PREV" > "$STATE_DIR/previous_tag"; fi
  echo "$TAG" > "$STATE_DIR/current_tag"
  log "OK: $WEB_IMAGE:$TAG is live"
  docker image prune -f --filter "until=168h" >/dev/null || true
  exit 0
fi

if [[ -n "$PREV" && "$PREV" != "$TAG" ]]; then
  log "FAILED: rolling back to $PREV"
  up_tag "$PREV"
  if wait_healthy; then log "rolled back to $PREV"; else log "rollback to $PREV is unhealthy too!"; fi
else
  log "FAILED and no previous tag to roll back to"
fi
exit 1
