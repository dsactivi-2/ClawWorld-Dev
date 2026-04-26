#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Production deployment for openclaw-teams
# Usage: [DRY_RUN=true] [IMAGE_TAG=v1.2.3] ./deploy.sh
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

log_info()    { echo -e "${BLUE}[INFO]${RESET}  $(date '+%Y-%m-%d %H:%M:%S') $*"; }
log_success() { echo -e "${GREEN}[OK]${RESET}    $(date '+%Y-%m-%d %H:%M:%S') $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${RESET}  $(date '+%Y-%m-%d %H:%M:%S') $*"; }
log_error()   { echo -e "${RED}[ERROR]${RESET} $(date '+%Y-%m-%d %H:%M:%S') $*" >&2; }
log_step()    { echo -e "\n${BOLD}${CYAN}==> $*${RESET}"; }

die() { log_error "$*"; exit 1; }

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

REGISTRY="${REGISTRY:-ghcr.io/clawworld}"
IMAGE_NAME="${IMAGE_NAME:-openclaw-teams}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo "latest")}"
FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"

NAMESPACE="${NAMESPACE:-openclaw-production}"
MANIFESTS_DIR="${REPO_ROOT}/kubernetes"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-300s}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/health}"

DRY_RUN="${DRY_RUN:-false}"

# -----------------------------------------------------------------------------
# Dry-run wrapper
# -----------------------------------------------------------------------------
run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    log_warn "[DRY RUN] Would execute: $*"
  else
    "$@"
  fi
}

# -----------------------------------------------------------------------------
# Step 1 — Check prerequisites
# -----------------------------------------------------------------------------
check_prerequisites() {
  log_step "Checking prerequisites"

  local missing=0
  for cmd in docker kubectl git curl; do
    if command -v "${cmd}" &>/dev/null; then
      log_success "${cmd} found: $(command -v "${cmd}")"
    else
      log_error "${cmd} not found — please install it"
      missing=$((missing + 1))
    fi
  done

  [[ ${missing} -gt 0 ]] && die "${missing} prerequisite(s) missing"

  # Docker daemon running?
  if ! docker info &>/dev/null; then
    die "Docker daemon is not running"
  fi
  log_success "Docker daemon is running"

  # kubectl can reach the cluster?
  if ! kubectl cluster-info --request-timeout=5s &>/dev/null; then
    die "kubectl cannot reach the Kubernetes cluster (check your kubeconfig)"
  fi
  log_success "kubectl cluster connection OK"

  # Namespace exists?
  if ! kubectl get namespace "${NAMESPACE}" &>/dev/null; then
    log_warn "Namespace '${NAMESPACE}' does not exist — it will be created from namespace.yaml"
  else
    log_success "Namespace '${NAMESPACE}' exists"
  fi
}

# -----------------------------------------------------------------------------
# Step 2 — Build Docker image
# -----------------------------------------------------------------------------
build_image() {
  log_step "Building Docker image"
  log_info "Image: ${FULL_IMAGE}"

  run docker build \
    --file "${REPO_ROOT}/docker/Dockerfile.production" \
    --tag "${FULL_IMAGE}" \
    --tag "${REGISTRY}/${IMAGE_NAME}:latest" \
    --build-arg BUILD_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --build-arg GIT_COMMIT="${IMAGE_TAG}" \
    --label "org.opencontainers.image.created=$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --label "org.opencontainers.image.revision=${IMAGE_TAG}" \
    --label "org.opencontainers.image.source=https://github.com/clawworld/openclaw-teams" \
    "${REPO_ROOT}"

  log_success "Image built: ${FULL_IMAGE}"
}

# -----------------------------------------------------------------------------
# Step 3 — Push to registry
# -----------------------------------------------------------------------------
push_image() {
  log_step "Pushing image to registry"

  run docker push "${FULL_IMAGE}"
  run docker push "${REGISTRY}/${IMAGE_NAME}:latest"

  log_success "Image pushed: ${FULL_IMAGE}"
}

# -----------------------------------------------------------------------------
# Step 4 — Apply Kubernetes manifests
# -----------------------------------------------------------------------------
apply_manifests() {
  log_step "Applying Kubernetes manifests"

  # secret.yaml contains REPLACE_ME placeholders and must be pre-provisioned
  # (via Sealed Secrets or External Secrets Operator) — never applied here.
  local manifest_order=(
    namespace.yaml
    configmap.yaml
    statefulset-postgres.yaml
    statefulset-redis.yaml
    deployment.yaml
    service.yaml
    ingress.yaml
    hpa.yaml
    networkpolicy.yaml
  )

  for manifest in "${manifest_order[@]}"; do
    local file="${MANIFESTS_DIR}/${manifest}"
    if [[ -f "${file}" ]]; then
      log_info "Applying ${manifest}"
      run kubectl apply -f "${file}" --namespace="${NAMESPACE}"
    else
      log_warn "Manifest not found, skipping: ${file}"
    fi
  done

  # Update deployment image tag
  log_info "Updating deployment image to ${FULL_IMAGE}"
  run kubectl set image deployment/openclaw-gateway \
    openclaw-gateway="${FULL_IMAGE}" \
    --namespace="${NAMESPACE}"

  log_success "Manifests applied"
}

# -----------------------------------------------------------------------------
# Step 5 — Run database migrations
# -----------------------------------------------------------------------------
run_db_migrations() {
  log_step "Running database migrations"

  local migration_dir="${REPO_ROOT}/sql/migrations"

  if [[ ! -d "${migration_dir}" ]]; then
    log_warn "No migrations directory at ${migration_dir} — skipping"
    return 0
  fi

  local migrations=()
  while IFS= read -r -d '' f; do
    migrations+=("$f")
  done < <(find "${migration_dir}" -maxdepth 1 -name "*.sql" -print0 | sort -z)

  if [[ ${#migrations[@]} -eq 0 ]]; then
    log_warn "No *.sql files in ${migration_dir} — skipping"
    return 0
  fi

  log_info "Found ${#migrations[@]} migration file(s)"

  # Locate a running postgres pod in the target namespace
  local pg_pod
  pg_pod=$(kubectl get pod \
    --namespace="${NAMESPACE}" \
    -l app.kubernetes.io/name=postgres \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

  [[ -z "${pg_pod}" ]] && die "No running postgres pod found in namespace ${NAMESPACE}"
  log_info "Using postgres pod: ${pg_pod}"

  for migration in "${migrations[@]}"; do
    local filename
    filename="$(basename "${migration}")"
    log_info "Applying migration: ${filename}"
    # Copy file into pod, run it, then clean up
    run kubectl cp "${migration}" "${NAMESPACE}/${pg_pod}:/tmp/${filename}"
    run kubectl exec "${pg_pod}" --namespace="${NAMESPACE}" -- \
      psql -U openclaw -d openclaw_teams -v ON_ERROR_STOP=1 -f "/tmp/${filename}"
    run kubectl exec "${pg_pod}" --namespace="${NAMESPACE}" -- rm "/tmp/${filename}"
  done

  log_success "All migrations applied successfully"
}

# -----------------------------------------------------------------------------
# Step 6 — Wait for rollout
# -----------------------------------------------------------------------------
wait_for_rollout() {
  log_step "Waiting for rollout to complete (timeout: ${ROLLOUT_TIMEOUT})"

  run kubectl rollout status deployment/openclaw-gateway \
    --namespace="${NAMESPACE}" \
    --timeout="${ROLLOUT_TIMEOUT}"

  log_success "Rollout complete"
}

# -----------------------------------------------------------------------------
# Step 7 — Health check
# -----------------------------------------------------------------------------
run_health_check() {
  log_step "Running post-deploy health check"

  # Port-forward in background for local health check
  if [[ "${DRY_RUN}" != "true" ]]; then
    kubectl port-forward \
      --namespace="${NAMESPACE}" \
      service/openclaw-gateway 18080:3000 &>/dev/null &
    PF_PID=$!
    trap 'kill ${PF_PID} 2>/dev/null || true' EXIT

    sleep 3

    local attempts=0
    local max_attempts=10
    while [[ ${attempts} -lt ${max_attempts} ]]; do
      if curl -sf "http://localhost:18080/health" &>/dev/null; then
        log_success "Health check passed"
        kill ${PF_PID} 2>/dev/null || true
        return 0
      fi
      attempts=$((attempts + 1))
      log_info "Health check attempt ${attempts}/${max_attempts}..."
      sleep 5
    done

    kill ${PF_PID} 2>/dev/null || true
    die "Health check failed after ${max_attempts} attempts"
  else
    log_warn "[DRY RUN] Skipping health check"
  fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  echo -e "\n${BOLD}${GREEN}OpenClaw Teams — Production Deployment${RESET}"
  echo -e "${CYAN}Image Tag : ${IMAGE_TAG}${RESET}"
  echo -e "${CYAN}Namespace : ${NAMESPACE}${RESET}"
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo -e "${YELLOW}Mode      : DRY RUN (no changes will be made)${RESET}"
  fi
  echo ""

  check_prerequisites
  build_image
  push_image
  apply_manifests
  run_db_migrations
  wait_for_rollout
  run_health_check

  echo -e "\n${BOLD}${GREEN}Deployment complete!${RESET}"
  echo -e "  Image : ${FULL_IMAGE}"
  echo -e "  URL   : https://ocw-dev.k8.activi.io"
}

main "$@"
