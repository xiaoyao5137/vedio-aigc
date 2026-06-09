#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/app.pid"
PLIST_FILE="$HOME/Library/LaunchAgents/com.video-aigc.app.plist"
SCREEN_NAME="video-aigc-app"
APP_PORT="${APP_PORT:-5173}"
DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/video_aigc}"

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST_FILE")"

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
  [[ -n "$(port_pid)" ]]
}

port_pid() {
  lsof -tiTCP:"$APP_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

write_launch_agent() {
  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.video-aigc.app</string>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "$ROOT_DIR" &amp;&amp; exec node scripts/dev-server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>APP_PORT</key>
    <string>$APP_PORT</string>
    <key>DATABASE_URL</key>
    <string>$DATABASE_URL</string>
    <key>PATH</key>
    <string>$PATH</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/app.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/app.log</string>
</dict>
</plist>
EOF
}

wait_for_database() {
  echo "Waiting for PostgreSQL..."
  for _ in {1..40}; do
    if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q '^video-aigc-postgres$'; then
      if docker exec video-aigc-postgres pg_isready -U postgres -d video_aigc >/dev/null 2>&1; then
        echo "PostgreSQL is ready."
        return 0
      fi
    elif command -v pg_isready >/dev/null 2>&1 && pg_isready -h 127.0.0.1 -p 5432 -U postgres -d video_aigc >/dev/null 2>&1; then
      echo "PostgreSQL is ready."
      return 0
    fi
    sleep 1
  done
  echo "PostgreSQL did not become ready in time." >&2
  return 1
}

ensure_local_database() {
  psql -d postgres -tc "select 1 from pg_roles where rolname = 'postgres'" | grep -q 1 || \
    psql -d postgres -c "create role postgres with login superuser password 'postgres'"

  psql -d postgres -tc "select 1 from pg_database where datname = 'video_aigc'" | grep -q 1 || \
    createdb -O postgres video_aigc
}

start_database() {
  cd "$ROOT_DIR"
  if docker_compose -f docker-compose.yml up -d postgres; then
    wait_for_database
    return
  fi

  if command -v brew >/dev/null 2>&1; then
    local formula
    formula="$(brew list --formula | grep -E '^postgresql(@[0-9]+)?$' | sort -Vr | head -n 1 || true)"
    if [[ -z "$formula" ]]; then
      formula="postgresql@16"
      brew install "$formula"
    fi

    if [[ "$formula" == postgresql@* ]]; then
      export PATH="$(brew --prefix "$formula")/bin:$PATH"
    else
      export PATH="$(brew --prefix "$formula")/bin:$PATH"
    fi
    brew services start "$formula"
    wait_for_database
    ensure_local_database
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

  local existing_pid
  existing_pid="$(port_pid)"
  if [[ -n "$existing_pid" ]]; then
    local existing_command
    existing_command="$(ps -p "$existing_pid" -o command= || true)"
    if [[ "$existing_command" == *"$ROOT_DIR"* ]]; then
      echo "Stopping existing app process on port $APP_PORT pid $existing_pid..."
      kill "$existing_pid"
      sleep 1
    else
      echo "Port $APP_PORT is already used by another process: $existing_command" >&2
      return 1
    fi
  fi

  if [[ ! -d node_modules ]]; then
    npm install
  fi

  echo "Starting app on http://127.0.0.1:$APP_PORT ..."
  if command -v screen >/dev/null 2>&1; then
    screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
    screen -dmS "$SCREEN_NAME" /bin/zsh -lc "cd '$ROOT_DIR' && APP_PORT='$APP_PORT' DATABASE_URL='$DATABASE_URL' exec node scripts/dev-server.mjs"
  elif command -v launchctl >/dev/null 2>&1; then
    write_launch_agent
    launchctl bootout "gui/$(id -u)" "$PLIST_FILE" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
    launchctl kickstart -k "gui/$(id -u)/com.video-aigc.app"
  else
    APP_PORT="$APP_PORT" DATABASE_URL="$DATABASE_URL" nohup node "$ROOT_DIR/scripts/dev-server.mjs" >"$LOG_DIR/app.log" 2>&1 &
  fi
  sleep 2

  if app_running; then
    port_pid > "$PID_FILE"
    echo "App started with pid $(cat "$PID_FILE"). Logs: $LOG_DIR/app.log"
  else
    echo "App failed to start. Check logs: $LOG_DIR/app.log" >&2
    return 1
  fi
}

stop_app() {
  if command -v screen >/dev/null 2>&1; then
    screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true
  fi

  if command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)" "$PLIST_FILE" >/dev/null 2>&1 || true
  fi

  if app_running; then
    echo "Stopping app pid $(cat "$PID_FILE")..."
    kill "$(port_pid)"
    rm -f "$PID_FILE"
  else
    rm -f "$PID_FILE"
  fi

  local existing_pid
  existing_pid="$(port_pid)"
  if [[ -n "$existing_pid" ]]; then
    local existing_command
    existing_command="$(ps -p "$existing_pid" -o command= || true)"
    if [[ "$existing_command" == *"$ROOT_DIR"* ]]; then
      echo "Stopping app process on port $APP_PORT pid $existing_pid..."
      kill "$existing_pid"
    fi
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
