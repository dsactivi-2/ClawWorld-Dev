#!/usr/bin/env bash
# =============================================================================
# maintenance.sh — Enable or disable maintenance mode for openclaw-teams
# Usage: ./maintenance.sh [enable|disable]
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
DEPLOYMENT="${DEPLOYMENT:-openclaw-gateway}"
INGRESS="${INGRESS:-openclaw-gateway}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-30}"

MAINTENANCE_ANNOTATION="openclaw.io/maintenance"
MAINTENANCE_IMAGE="${MAINTENANCE_IMAGE:-ghcr.io/clawworld/openclaw-maintenance:latest}"

# -----------------------------------------------------------------------------
# Show current maintenance state
# -----------------------------------------------------------------------------
show_status() {
  local annotation
  annotation=$(kubectl get ingress "${INGRESS}" \
    --namespace="${NAMESPACE}" \
    -o jsonpath="{.metadata.annotations.${MAINTENANCE_ANNOTATION}}" 2>/dev/null || echo "disabled")
  echo -e "${CYAN}Maintenance mode: ${BOLD}${annotation:-disabled}${RESET}"
}

# -----------------------------------------------------------------------------
# Enable maintenance mode
# -----------------------------------------------------------------------------
enable_maintenance() {
  log_step "Enabling maintenance mode"

  # 1 — Annotate ingress so nginx returns 503 with maintenance page
  log_info "Patching ingress to serve maintenance page"
  kubectl annotate ingress "${INGRESS}" \
    --namespace="${NAMESPACE}" \
    --overwrite \
    "nginx.ingress.kubernetes.io/custom-http-errors=503" \
    "nginx.ingress.kubernetes.io/default-backend=openclaw-maintenance" \
    "${MAINTENANCE_ANNOTATION}=enabled"

  # 2 — Scale down gateway replicas to 0 after draining connections
  log_info "Waiting ${DRAIN_TIMEOUT}s for connections to drain..."
  sleep "${DRAIN_TIMEOUT}"

  # Capture current replica count before scaling to 0 so disable can restore it
  local current_replicas
  current_replicas=$(kubectl get deployment "${DEPLOYMENT}" \
    --namespace="${NAMESPACE}" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "2")
  current_replicas="${current_replicas:-2}"
  kubectl annotate deployment "${DEPLOYMENT}" \
    --namespace="${NAMESPACE}" \
    --overwrite \
    "openclaw.io/pre-maintenance-replicas=${current_replicas}"

  log_info "Scaling down ${DEPLOYMENT} (was ${current_replicas} replicas)"
  kubectl scale deployment "${DEPLOYMENT}" \
    --namespace="${NAMESPACE}" \
    --replicas=0

  # 3 — Label namespace for awareness
  kubectl label namespace "${NAMESPACE}" \
    "openclaw.io/maintenance=enabled" --overwrite

  log_success "Maintenance mode ENABLED"
  log_warn "Application is offline. Run './maintenance.sh disable' to restore."
}

# -----------------------------------------------------------------------------
# Disable maintenance mode
# -----------------------------------------------------------------------------
disable_maintenance() {
  log_step "Disabling maintenance mode"

  # 1 — Restore ingress annotations
  log_info "Restoring ingress annotations"
  kubectl annotate ingress "${INGRESS}" \
    --namespace="${NAMESPACE}" \
    --overwrite \
    "nginx.ingress.kubernetes.io/custom-http-errors-" \
    "nginx.ingress.kubernetes.io/default-backend-" \
    "${MAINTENANCE_ANNOTATION}-" 2>/dev/null || true

  # 2 — Scale gateway back up to pre-maintenance replica count
  local target_replicas
  target_replicas=$(kubectl get deployment "${DEPLOYMENT}" \
    --namespace="${NAMESPACE}" \
    -o jsonpath='{.metadata.annotations.openclaw\.io/pre-maintenance-replicas}' 2>/dev/null || echo "2")
  target_replicas="${target_replicas:-2}"

  log_info "Scaling up ${DEPLOYMENT} to ${target_replicas} replicas (pre-maintenance count)"
  kubectl scale deployment "${DEPLOYMENT}" \
    --namespace="${NAMESPACE}" \
    --replicas="${target_replicas}"

  # 3 — Wait for pods to be ready
  log_info "Waiting for deployment to be ready..."
  kubectl rollout status deployment/"${DEPLOYMENT}" \
    --namespace="${NAMESPACE}" \
    --timeout=120s

  # 4 — Remove maintenance label
  kubectl label namespace "${NAMESPACE}" \
    "openclaw.io/maintenance-" --overwrite 2>/dev/null || true

  log_success "Maintenance mode DISABLED — application is back online"
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  local action="${1:-}"

  echo -e "\n${BOLD}${CYAN}OpenClaw Teams — Maintenance Mode${RESET}"
  echo -e "Namespace : ${NAMESPACE}\n"

  case "${action}" in
    enable)
      show_status
      if [[ "${CI:-false}" != "true" ]]; then
        read -rp "$(echo -e "${RED}Enable maintenance? This will take the app offline. [y/N]:${RESET} ")" confirm
        [[ "${confirm}" =~ ^[Yy]$ ]] || { log_info "Aborted"; exit 0; }
      fi
      enable_maintenance
      ;;
    disable)
      show_status
      disable_maintenance
      ;;
    status)
      show_status
      ;;
    "")
      echo -e "${YELLOW}Usage: $0 [enable|disable|status]${RESET}"
      show_status
      exit 0
      ;;
    *)
      die "Unknown action '${action}'. Use: enable | disable | status"
      ;;
  esac
}

main "$@"
