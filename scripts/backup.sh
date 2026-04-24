#!/usr/bin/env bash
# =============================================================================
# backup.sh — Database backup for openclaw-teams
# Usage: [S3_BUCKET=mybucket] [DRY_RUN=true] ./backup.sh
# Outputs to S3 if configured, otherwise to LOCAL_BACKUP_DIR
# =============================================================================
set -euo pipefail

# -----------------------------------------------------------------------------
# Color helpers
# -----------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${RESET}  $(date '+%H:%M:%S') $*"; }
log_success() { echo -e "${GREEN}[OK]${RESET}    $(date '+%H:%M:%S') $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${RESET}  $(date '+%H:%M:%S') $*"; }
log_error()   { echo -e "${RED}[ERROR]${RESET} $(date '+%H:%M:%S') $*" >&2; }
log_step()    { echo -e "\n${BOLD}${CYAN}==> $*${RESET}"; }

die() { log_error "$*"; exit 1; }

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
NAMESPACE="${NAMESPACE:-openclaw-production}"
POSTGRES_DB="${POSTGRES_DB:-openclaw_teams}"
POSTGRES_USER="${POSTGRES_USER:-openclaw}"

S3_BUCKET="${S3_BUCKET:-${BACKUP_BUCKET:-}}"
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-}"
S3_PREFIX="${S3_PREFIX:-backups}"

LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-/tmp/openclaw-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DRY_RUN="${DRY_RUN:-false}"

TIMESTAMP="$(date '+%Y%m%d_%H%M%S')"
PG_BACKUP_FILE="postgres_${POSTGRES_DB}_${TIMESTAMP}.sql.gz"
REDIS_BACKUP_FILE="redis_dump_${TIMESTAMP}.rdb.gz"

run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    log_warn "[DRY RUN] Would run: $*"
  else
    "$@"
  fi
}

# -----------------------------------------------------------------------------
# Detect storage backend
# -----------------------------------------------------------------------------
use_s3() {
  [[ -n "${S3_BUCKET}" ]] && command -v aws &>/dev/null
}

# -----------------------------------------------------------------------------
# Step 1 — PostgreSQL backup via pg_dump
# -----------------------------------------------------------------------------
backup_postgres() {
  log_step "PostgreSQL backup — pg_dump"

  if ! kubectl get pod postgres-0 --namespace="${NAMESPACE}" &>/dev/null; then
    die "postgres-0 pod not found"
  fi

  local tmp_file="${LOCAL_BACKUP_DIR}/${PG_BACKUP_FILE}"
  mkdir -p "${LOCAL_BACKUP_DIR}"

  log_info "Dumping database '${POSTGRES_DB}' from postgres-0"

  if [[ "${DRY_RUN}" != "true" ]]; then
    kubectl exec postgres-0 --namespace="${NAMESPACE}" -- \
      pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
      --format=plain --no-password \
      | gzip -9 > "${tmp_file}"

    local size
    size=$(du -sh "${tmp_file}" | cut -f1)
    log_success "Dump written: ${tmp_file} (${size})"
  else
    log_warn "[DRY RUN] Would dump to ${tmp_file}"
    return
  fi

  # Upload or keep local
  if use_s3; then
    upload_to_s3 "${tmp_file}" "${PG_BACKUP_FILE}"
    rm -f "${tmp_file}"
  else
    log_info "S3 not configured — backup retained locally: ${tmp_file}"
  fi
}

# -----------------------------------------------------------------------------
# Step 2 — Redis backup (BGSAVE)
# -----------------------------------------------------------------------------
backup_redis() {
  log_step "Redis backup — BGSAVE"

  if ! kubectl get pod redis-0 --namespace="${NAMESPACE}" &>/dev/null; then
    log_warn "redis-0 pod not found — skipping Redis backup"
    return
  fi

  if [[ "${DRY_RUN}" != "true" ]]; then
    log_info "Triggering BGSAVE on redis-0"
    kubectl exec redis-0 --namespace="${NAMESPACE}" -- \
      redis-cli -a "${REDIS_PASSWORD:-}" BGSAVE 2>/dev/null

    # Wait for BGSAVE to complete
    local retries=0
    while [[ ${retries} -lt 30 ]]; do
      local status
      status=$(kubectl exec redis-0 --namespace="${NAMESPACE}" -- \
        redis-cli -a "${REDIS_PASSWORD:-}" LASTSAVE 2>/dev/null || echo "0")
      # Guard against non-numeric status (e.g. auth error output)
      if ! [[ "${status}" =~ ^[0-9]+$ ]]; then status=0; fi
      local last_save_age=$(( $(date +%s) - status ))
      if [[ ${last_save_age} -lt 30 ]]; then
        break
      fi
      log_info "Waiting for BGSAVE to complete (${retries}/30)..."
      sleep 2
      retries=$((retries + 1))
    done

    local tmp_file="${LOCAL_BACKUP_DIR}/${REDIS_BACKUP_FILE}"
    mkdir -p "${LOCAL_BACKUP_DIR}"

    # Copy dump.rdb from the pod and compress
    kubectl cp \
      "${NAMESPACE}/redis-0:/data/dump.rdb" \
      "${LOCAL_BACKUP_DIR}/dump.rdb" 2>/dev/null

    gzip -9 "${LOCAL_BACKUP_DIR}/dump.rdb" 2>/dev/null
    mv "${LOCAL_BACKUP_DIR}/dump.rdb.gz" "${tmp_file}"

    local size
    size=$(du -sh "${tmp_file}" | cut -f1)
    log_success "Redis backup: ${tmp_file} (${size})"

    if use_s3; then
      upload_to_s3 "${tmp_file}" "${REDIS_BACKUP_FILE}"
      rm -f "${tmp_file}"
    else
      log_info "Redis backup retained locally: ${tmp_file}"
    fi
  else
    log_warn "[DRY RUN] Would trigger BGSAVE and copy dump.rdb"
  fi
}

# -----------------------------------------------------------------------------
# Step 3 — Upload to S3
# -----------------------------------------------------------------------------
upload_to_s3() {
  local local_file="$1"
  local remote_name="$2"
  local s3_path="s3://${S3_BUCKET}/${S3_PREFIX}/${remote_name}"

  # Build optional endpoint flag (used for Backblaze B2, Cloudflare R2, MinIO, etc.)
  local endpoint_flag=()
  [[ -n "${AWS_ENDPOINT_URL:-}" ]] && endpoint_flag=(--endpoint-url "${AWS_ENDPOINT_URL}")

  log_info "Uploading to ${s3_path}"
  aws s3 cp "${local_file}" "${s3_path}" \
    --region "${AWS_REGION}" \
    "${endpoint_flag[@]}"

  log_success "Uploaded: ${s3_path}"
}

# -----------------------------------------------------------------------------
# Step 4 — Verify backup integrity
# -----------------------------------------------------------------------------
verify_backups() {
  log_step "Verifying backup integrity"

  if use_s3 && [[ "${DRY_RUN}" != "true" ]]; then
    local endpoint_flag=()
    [[ -n "${AWS_ENDPOINT_URL:-}" ]] && endpoint_flag=(--endpoint-url "${AWS_ENDPOINT_URL}")
    for file in "${PG_BACKUP_FILE}" "${REDIS_BACKUP_FILE}"; do
      local s3_path="s3://${S3_BUCKET}/${S3_PREFIX}/${file}"
      if aws s3 ls "${s3_path}" --region "${AWS_REGION}" "${endpoint_flag[@]}" &>/dev/null; then
        local size
        size=$(aws s3 ls "${s3_path}" --region "${AWS_REGION}" "${endpoint_flag[@]}" | awk '{print $3}')
        if [[ "${size:-0}" -gt 0 ]]; then
          log_success "Verified: ${file} (${size} bytes)"
        else
          log_error "Empty backup: ${s3_path}"
        fi
      else
        log_warn "Could not find: ${s3_path}"
      fi
    done
  else
    # Local verification
    for f in "${LOCAL_BACKUP_DIR}/${PG_BACKUP_FILE}" "${LOCAL_BACKUP_DIR}/${REDIS_BACKUP_FILE}"; do
      if [[ -f "${f}" ]]; then
        if gzip -t "${f}" 2>/dev/null; then
          local size
          size=$(du -sh "${f}" | cut -f1)
          log_success "Verified: $(basename "${f}") (${size})"
        else
          log_error "Corrupt backup: ${f}"
        fi
      fi
    done
  fi
}

# -----------------------------------------------------------------------------
# Step 5 — Delete backups older than RETENTION_DAYS
# -----------------------------------------------------------------------------
prune_old_backups() {
  log_step "Pruning backups older than ${RETENTION_DAYS} days"

  if use_s3 && [[ "${DRY_RUN}" != "true" ]]; then
    local cutoff
    cutoff=$(date -d "${RETENTION_DAYS} days ago" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || \
             date -v-"${RETENTION_DAYS}"d '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || \
             echo "")

    if [[ -z "${cutoff}" ]]; then
      log_warn "Cannot compute cutoff date — skipping S3 prune"
      return
    fi

    log_info "Listing S3 backups older than ${cutoff}"
    aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
      --region "${AWS_REGION}" 2>/dev/null | \
    while read -r date time size filename; do
      local file_date="${date}T${time}"
      if [[ "${file_date}" < "${cutoff}" ]]; then
        log_info "Deleting old backup: ${filename}"
        aws s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}/${filename}" \
          --region "${AWS_REGION}" 2>/dev/null || true
      fi
    done
    log_success "S3 prune complete"
  else
    # Local prune
    if [[ -d "${LOCAL_BACKUP_DIR}" ]]; then
      local count
      count=$(find "${LOCAL_BACKUP_DIR}" -type f \
        -mtime "+${RETENTION_DAYS}" 2>/dev/null | wc -l | tr -d ' ')
      if [[ "${count}" -gt 0 ]]; then
        log_info "Removing ${count} local backup(s) older than ${RETENTION_DAYS} days"
        if [[ "${DRY_RUN}" != "true" ]]; then
          find "${LOCAL_BACKUP_DIR}" -type f -mtime "+${RETENTION_DAYS}" -delete
        fi
      else
        log_info "No old local backups to remove"
      fi
    fi
  fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  echo -e "\n${BOLD}${GREEN}OpenClaw Teams — Database Backup${RESET}"
  echo -e "${CYAN}Timestamp : ${TIMESTAMP}${RESET}"
  echo -e "${CYAN}Namespace : ${NAMESPACE}${RESET}"
  if use_s3; then
    echo -e "${CYAN}Storage   : S3 — s3://${S3_BUCKET}/${S3_PREFIX}/${RESET}"
  else
    echo -e "${CYAN}Storage   : Local — ${LOCAL_BACKUP_DIR}${RESET}"
  fi
  [[ "${DRY_RUN}" == "true" ]] && echo -e "${YELLOW}Mode      : DRY RUN${RESET}"
  echo ""

  backup_postgres
  backup_redis
  verify_backups
  prune_old_backups

  echo -e "\n${BOLD}${GREEN}Backup complete!${RESET}"
  echo -e "  PostgreSQL : ${PG_BACKUP_FILE}"
  echo -e "  Redis      : ${REDIS_BACKUP_FILE}"
}

main "$@"
