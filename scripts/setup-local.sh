#!/usr/bin/env bash
# =============================================================================
# OpenClaw Teams — Lokales Setup
# Startet PostgreSQL + Redis, führt Migrationen aus, füllt .env.production
#
# Verwendung: bash scripts/setup-local.sh
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.production"
COMPOSE_FILE="$REPO_ROOT/docker-compose.dev.yml"

DB_PASSWORD="96427f508632653ab201beae4499507404acec989eef9f71"
REDIS_PASSWORD="f5ca945820a24ec6795d1d356f2393cc6b40558de27da2fa"
DB_HOST="localhost"
DB_PORT="5432"
DB_NAME="openclaw_teams"
DB_USER="openclaw"
REDIS_HOST="localhost"
REDIS_PORT="6379"

# ─── Farben ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ─── Docker prüfen ────────────────────────────────────────────────────────────
check_docker() {
  if ! command -v docker &>/dev/null; then
    error "Docker nicht gefunden. Installiere Docker Desktop: https://www.docker.com/products/docker-desktop"
    exit 1
  fi
  if ! docker info &>/dev/null; then
    error "Docker läuft nicht. Starte Docker Desktop und versuche es erneut."
    exit 1
  fi
  success "Docker ist bereit"
}

# ─── Services starten ─────────────────────────────────────────────────────────
start_services() {
  info "Starte PostgreSQL + Redis..."
  docker compose -f "$COMPOSE_FILE" up -d postgres redis

  info "Warte auf PostgreSQL..."
  local retries=30
  until docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_isready -U "$DB_USER" -d "$DB_NAME" &>/dev/null; do
    retries=$((retries - 1))
    if [[ $retries -le 0 ]]; then
      error "PostgreSQL antwortet nicht nach 30 Sekunden"
      docker compose -f "$COMPOSE_FILE" logs postgres
      exit 1
    fi
    sleep 1
  done
  success "PostgreSQL läuft auf localhost:$DB_PORT"

  info "Warte auf Redis..."
  retries=20
  until docker compose -f "$COMPOSE_FILE" exec -T redis \
    redis-cli -a "$REDIS_PASSWORD" ping 2>/dev/null | grep -q PONG; do
    retries=$((retries - 1))
    if [[ $retries -le 0 ]]; then
      error "Redis antwortet nicht nach 20 Sekunden"
      docker compose -f "$COMPOSE_FILE" logs redis
      exit 1
    fi
    sleep 1
  done
  success "Redis läuft auf localhost:$REDIS_PORT"
}

# ─── Migrationen ausführen ────────────────────────────────────────────────────
run_migrations() {
  info "Führe Datenbankmigrationen aus..."
  local migration_dir="$REPO_ROOT/sql/migrations"

  if [[ ! -d "$migration_dir" ]]; then
    warn "Kein migrations-Ordner gefunden, überspringe"
    return
  fi

  for f in "$migration_dir"/*.sql; do
    [[ -f "$f" ]] || continue
    local name
    name="$(basename "$f")"
    info "  → $name"
    PGPASSWORD="$DB_PASSWORD" psql \
      "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME" \
      -f "$f" -q || {
      error "Migration $name fehlgeschlagen"
      exit 1
    }
  done
  success "Alle Migrationen erfolgreich"
}

# ─── .env.production aktualisieren ───────────────────────────────────────────
update_env() {
  info "Aktualisiere .env.production mit lokalen Connection Strings..."

  local database_url="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
  local redis_url="redis://:$REDIS_PASSWORD@$REDIS_HOST:$REDIS_PORT/0"

  update_env_var() {
    local key="$1"
    local val="$2"
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
      # macOS-kompatibles sed
      sed -i '' "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
    else
      echo "${key}=${val}" >> "$ENV_FILE"
    fi
  }

  update_env_var "DB_HOST"      "$DB_HOST"
  update_env_var "DB_PORT"      "$DB_PORT"
  update_env_var "DB_NAME"      "$DB_NAME"
  update_env_var "DB_USER"      "$DB_USER"
  update_env_var "DB_PASSWORD"  "$DB_PASSWORD"
  update_env_var "DATABASE_URL" "$database_url"
  update_env_var "REDIS_HOST"   "$REDIS_HOST"
  update_env_var "REDIS_PORT"   "$REDIS_PORT"
  update_env_var "REDIS_PASSWORD" "$REDIS_PASSWORD"
  update_env_var "REDIS_URL"    "$redis_url"

  success ".env.production aktualisiert"
}

# ─── Verbindungstest ──────────────────────────────────────────────────────────
verify_connections() {
  info "Teste Verbindungen..."

  # PostgreSQL
  if PGPASSWORD="$DB_PASSWORD" psql \
    "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME" \
    -c "SELECT version();" -q &>/dev/null; then
    success "PostgreSQL Verbindung ✓"
  else
    error "PostgreSQL Verbindungstest fehlgeschlagen"
    exit 1
  fi

  # Redis
  local redis_ping
  redis_ping=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" ping 2>/dev/null || echo "FAIL")
  if [[ "$redis_ping" == "PONG" ]]; then
    success "Redis Verbindung ✓"
  else
    warn "redis-cli nicht lokal installiert, überspringe Redis-Ping-Test"
  fi
}

# ─── Zusammenfassung ──────────────────────────────────────────────────────────
print_summary() {
  echo ""
  echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  OpenClaw Teams — Lokale Services bereit  ${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  ${BLUE}PostgreSQL${NC}"
  echo    "    Host:     localhost:$DB_PORT"
  echo    "    Datenbank: $DB_NAME"
  echo    "    User:     $DB_USER"
  echo    "    Password: $DB_PASSWORD"
  echo ""
  echo -e "  ${BLUE}Redis${NC}"
  echo    "    Host:     localhost:$REDIS_PORT"
  echo    "    Password: $REDIS_PASSWORD"
  echo ""
  echo -e "  ${YELLOW}Noch nötig (externe Services):${NC}"
  echo    "    ANTHROPIC_API_KEY → https://console.anthropic.com"
  echo    "    SLACK_BOT_TOKEN   → https://api.slack.com/apps"
  echo    "    GITHUB_TOKEN      → https://github.com/settings/tokens"
  echo    "    SMTP_PASSWORD     → https://resend.com"
  echo ""
  echo    "  Starte die App mit:"
  echo -e "  ${BLUE}pnpm dev${NC}  (oder pnpm start für Production)"
  echo ""
  echo -e "  pgAdmin GUI (optional):"
  echo    "  docker compose -f docker-compose.dev.yml --profile tools up -d pgadmin"
  echo    "  → http://localhost:5050  (admin@openclaw.local / admin)"
  echo ""
}

# ─── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BLUE}OpenClaw Teams — Lokales Setup${NC}"
  echo -e "${BLUE}══════════════════════════════${NC}"
  echo ""

  check_docker
  start_services
  run_migrations
  update_env
  verify_connections
  print_summary
}

main "$@"
