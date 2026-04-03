#!/bin/sh
set -eu

APP_URL="${E2E_BASE_URL:-http://localhost}"

wait_for_app() {
  attempts=0
  while :; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/favicon.ico" 2>/dev/null || true)
    if [ "$code" = "204" ]; then
      return 0
    fi

    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      echo "Timed out waiting for app at $APP_URL" >&2
      return 1
    fi
    sleep 1
  done
}

wait_for_test_hooks() {
  attempts=0
  while :; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP_URL/api/test/reset-rooms" 2>/dev/null || true)
    if [ "$code" = "200" ]; then
      return 0
    fi

    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      echo "Timed out waiting for test hooks at $APP_URL" >&2
      return 1
    fi
    sleep 1
  done
}

cleanup() {
  docker compose up -d --build --force-recreate app >/dev/null
  wait_for_app
}

trap cleanup EXIT INT TERM

E2E_ENABLE_TEST_HOOKS=1 docker compose up -d --build --force-recreate app
wait_for_app
wait_for_test_hooks
npx playwright test "$@"