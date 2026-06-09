#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/app.pid"
APP_PORT="${APP_PORT:-5173}"
DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/video_aigc}"

mkdir -p "$LOG_DIR"

docker_compose() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
    return 0
  fi
  return 1
}

app_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1
}

wait_for_database() {
  echo "Waiting for PostgreSQL..."
  for _ in {1..40}; do
    if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q '^video-aigc-postgres$'; then
      if docker exec video-aigc-postgres pg_isready -U postgres -d video_aigc >/dev/null 2>&1; then
        echo "PostgreSQL is ready."
        return 0
      fi
    elif command -v pg_isready >/dev/null 2>&1 && pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; then
      echo "PostgreSQL is ready."
      return 0
    fi
    sleep 1
  done
  echo "PostgreSQL did not become ready in time." >&2
  return 1
}

start_database() {
  cd "$ROOT_DIR"
  if docker_compose -f docker-compose.yml up -d postgres; then
    wait_for_database
    return
  fi

  if command -v brew >/dev/null 2>&1; then
    if brew services list | grep -q 'postgresql@16'; then
      brew services start postgresql@16
    else
      brew services start postgresql
    fi
    createdb video_aigc >/dev/null 2>&1 || true
    wait_for_database
    return
  fi

  echo "No supported PostgreSQL launcher found. Install Docker or start PostgreSQL manually." >&2
  return 1
}

stop_database() {
  cd "$ROOT_DIR"
  docker_compose -f docker-compose.yml stop postgres >/dev/null 2>&1 || true
}

start_app() {
  cd "$ROOT_DIR"
  if app_running; then
    echo "App is already running on pid $(cat "$PID_FILE")."
    return
  fi

  if [[ ! -d node_modules ]]; then
    npm install
  fi

  echo "Starting app on http://127.0.0.1:$APP_PORT ..."
  DATABASE_URL="$DATABASE_URL" nohup npm run dev -- --host 127.0.0.1 --port "$APP_PORT" >"$LOG_DIR/app.log" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1

  if app_running; then
    echo "App started with pid $(cat "$PID_FILE"). Logs: $LOG_DIR/app.log"
  else
    echo "App failed to start. Check logs: $LOG_DIR/app.log" >&2
    return 1
  fi
}

stop_app() {
  if app_running; then
    echo "Stopping app pid $(cat "$PID_FILE")..."
    kill "$(cat "$PID_FILE")"
    rm -f "$PID_FILE"
  else
    rm -f "$PID_FILE"
  fi
}

status() {
  if app_running; then
    echo "App: running on pid $(cat "$PID_FILE")"
  else
    echo "App: stopped"
  fi

  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q '^video-aigc-postgres$'; then
    echo "PostgreSQL: running in Docker container video-aigc-postgres"
  elif command -v pg_isready >/dev/null 2>&1 && pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; then
    echo "PostgreSQL: running at $DATABASE_URL"
  else
    echo "PostgreSQL: stopped or unreachable"
  fi
}

case "${1:-start}" in
  start)
    start_database
    start_app
    ;;
  restart)
    stop_app
    stop_database
    start_database
    start_app
    ;;
  stop)
    stop_app
    stop_database
    ;;
  status)
    status
    ;;
  logs)
    tail -f "$LOG_DIR/app.log"
    ;;
  *)
    echo "Usage: $0 {start|restart|stop|status|logs}" >&2
    exit 1
    ;;
esac
