#!/usr/bin/env bash
# ==============================================================================
# NEPTUNE-AI: Unified System Control & Startup Manager
# ==============================================================================
# Controls the entire Neptune-AI stack (Backend, Asterisk, Ollama, Whisper, Piper, Caddy).
# Usage:
#   neptune start      - Start all services, warm up AI model, and check health
#   neptune stop       - Gracefully stop all Neptune services
#   neptune restart    - Restart all services
#   neptune status     - View live container health, SIP endpoints, and RAM usage
#   neptune warmup     - Preload Qwen 2.5 LLM into memory for instant voice responses
#   neptune enable-boot - Install systemd service to start Neptune automatically on VM boot
# ==============================================================================

set -e

# Resolve project root regardless of where this script is called from
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_SOURCE" ]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  [[ $SCRIPT_SOURCE != /* ]] && SCRIPT_SOURCE="$SCRIPT_DIR/$SCRIPT_SOURCE"
done
PROJECT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")/.." >/dev/null 2>&1 && pwd)"
cd "$PROJECT_DIR"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

log_info() { echo -e "${CYAN}[Neptune-AI]${NC} $1"; }
log_ok() { echo -e "${GREEN}[✔]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[!]${NC} $1"; }
log_err() { echo -e "${RED}[✘]${NC} $1"; }

cmd_start() {
  echo -e "\n${BOLD}${CYAN}================================================================${NC}"
  echo -e "${BOLD}${CYAN}           NEPTUNE-AI: Starting Complete System Stack            ${NC}"
  echo -e "${BOLD}${CYAN}================================================================${NC}\n"

  # Ensure Docker is running
  if ! docker info >/dev/null 2>&1; then
    log_warn "Docker service is not running. Attempting to start systemd docker..."
    sudo systemctl start docker || true
    sleep 2
  fi

  log_info "Launching Docker containers (Caddy, Backend, Asterisk, Ollama, Whisper, Piper)..."
  docker compose up -d

  log_info "Waiting for core services to become ready..."
  sleep 4

  # Preload / Warm up Ollama model into memory
  cmd_warmup

  log_ok "All Neptune-AI services are running and ready!"
  cmd_status
}

cmd_warmup() {
  log_info "Preloading Qwen 2.5 LLM model into RAM for zero-latency voice responses..."
  local MODEL_NAME="qwen2.5:1.5b"
  if [ -f .env ]; then
    local ENV_MODEL
    ENV_MODEL=$(grep -E "^LLM_MODEL=" .env | tail -n 1 | cut -d '=' -f 2 || true)
    if [ -n "$ENV_MODEL" ]; then
      MODEL_NAME="$ENV_MODEL"
    fi
  fi

  if docker exec neptune-ollama ollama run "$MODEL_NAME" "Ready" >/dev/null 2>&1; then
    log_ok "AI model '$MODEL_NAME' is active in RAM."
  else
    log_warn "Could not preload '$MODEL_NAME'; will load dynamically upon first query."
  fi
}

cmd_stop() {
  echo -e "\n${BOLD}${YELLOW}Stopping Neptune-AI services...${NC}"
  docker compose stop
  log_ok "All Neptune-AI services have been stopped."
}

cmd_restart() {
  echo -e "\n${BOLD}${CYAN}Restarting Neptune-AI services...${NC}"
  docker compose restart
  cmd_warmup
  cmd_status
}

cmd_status() {
  echo -e "\n${BOLD}${CYAN}--- Neptune-AI Container Status ---${NC}"
  docker compose ps

  echo -e "\n${BOLD}${CYAN}--- Asterisk Telephony Status ---${NC}"
  if docker ps | grep -q "neptune-asterisk"; then
    docker exec neptune-asterisk asterisk -rx "pjsip show endpoints" 2>/dev/null || echo "Asterisk starting up..."
  else
    echo "Asterisk container is not running."
  fi

  echo -e "\n${BOLD}${CYAN}--- System Memory Envelope ---${NC}"
  free -h

  echo -e "\n${BOLD}${GREEN}Cockpit URL:${NC} https://neptune.home.arpa  (or https://$(hostname -I | awk '{print $1}'))"
  echo -e "${BOLD}${GREEN}SIP Extension:${NC} Dial 7000 from Ext 1001 (Primary) or Ext 1002 (Desk)\n"
}

cmd_enable_boot() {
  log_info "Creating systemd service for automatic startup on VM boot..."
  local SERVICE_FILE="/etc/systemd/system/neptune.service"

  sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Neptune-AI Autonomous Smart Home Assistant
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose stop
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable neptune.service
  log_ok "Automatic boot startup enabled! Neptune will now start automatically whenever your VM boots up."
}

# Main Dispatcher
case "${1:-start}" in
  start)
    cmd_start
    ;;
  stop)
    cmd_stop
    ;;
  restart)
    cmd_restart
    ;;
  status)
    cmd_status
    ;;
  warmup)
    cmd_warmup
    ;;
  enable-boot)
    cmd_enable_boot
    ;;
  *)
    echo "Usage: neptune {start|stop|restart|status|warmup|enable-boot}"
    exit 1
    ;;
esac
