#!/usr/bin/env bash
# docker compose for the production stack, with the right env file and the deployed image tag.
#
#   infra/scripts/compose.sh ps
#   infra/scripts/compose.sh logs -f web
#   APP_ENV_FILE=./my.env infra/scripts/compose.sh up -d --build     # local test
#
# Env:
#   APP_ENV_FILE  app env file (default: <app dir>/.env, i.e. /opt/app/.env on the server)
#   STATE_DIR     deploy state (default: <app dir>/.deploy) — holds web_image + current_tag
#   WEB_IMAGE / WEB_TAG override the remembered image.
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-$(dirname "$INFRA_DIR")}"
APP_ENV_FILE="$(realpath -m "${APP_ENV_FILE:-$APP_DIR/.env}")"
export APP_ENV_FILE
STATE_DIR="${STATE_DIR:-$APP_DIR/.deploy}"

if [[ ! -f "$APP_ENV_FILE" ]]; then
  echo "env file not found: $APP_ENV_FILE (set APP_ENV_FILE)" >&2
  exit 1
fi
if [[ -z "${WEB_IMAGE:-}" && -f "$STATE_DIR/web_image" ]]; then
  WEB_IMAGE="$(cat "$STATE_DIR/web_image")"; export WEB_IMAGE
fi
if [[ -z "${WEB_TAG:-}" && -f "$STATE_DIR/current_tag" ]]; then
  WEB_TAG="$(cat "$STATE_DIR/current_tag")"; export WEB_TAG
fi

exec docker compose --env-file "$APP_ENV_FILE" -f "$INFRA_DIR/compose.prod.yml" "$@"
