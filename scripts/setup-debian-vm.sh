#!/bin/bash
# ==============================================================================
# NEPTUNE-AI DEBIAN 12 / 13 (TRIXIE) VM - ENVIRONMENT BOOTSTRAP SCRIPT
# ==============================================================================
# Target: Debian 12 (Bookworm) or Debian 13 (Trixie) VM (6 vCPUs, 8.0 GB RAM)
# Purpose: Prepares system dependencies, AVX2 CPU validation, Docker CE engine,
# Docker Compose plugin, UFW firewall rules, and deployment directory layout.
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}====================================================${NC}"
echo -e "${CYAN}   NEPTUNE-AI Debian VM Bootstrap & Setup           ${NC}"
echo -e "${CYAN}====================================================${NC}"

# Check for root or sudo
if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}[ERROR] Please run this script as root or with sudo.${NC}"
    exit 1
fi

REAL_USER="${SUDO_USER:-$(whoami)}"

# 1. Hardware & Virtualization Verification
echo -e "\n${CYAN}--- Step 1: Validating Hardware & Virtualization Setup ---${NC}"
TOTAL_RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
VCPU_COUNT=$(nproc)
DEBIAN_VERSION=$(. /etc/os-release && echo "${PRETTY_NAME:-Debian}")

echo -e "Detected OS:    ${GREEN}${DEBIAN_VERSION}${NC}"
echo -e "Detected vCPUs: ${GREEN}${VCPU_COUNT}${NC}"
echo -e "Detected RAM:   ${GREEN}${TOTAL_RAM_MB} MB${NC}"

if [ "$TOTAL_RAM_MB" -lt 7000 ]; then
    echo -e "${YELLOW}[WARNING] Total RAM is under 7500 MB. Ensure Proxmox allocated at least 8.0 GB to this VM.${NC}"
fi

# Critical: Check for AVX2 instructions (required by Whisper & Piper CPU inference)
if grep -q "avx2" /proc/cpuinfo; then
    echo -e "${GREEN}[OK] AVX2 CPU instruction set detected.${NC} (CPU type is correctly set to 'host')"
else
    echo -e "${RED}[CRITICAL ERROR] AVX2 CPU instructions NOT found!${NC}"
    echo -e "Proxmox VM CPU type is likely set to 'kvm64' or 'qemu64'."
    echo -e "Please shut down the VM, open Proxmox Hardware -> Processors -> Type, and select 'host'."
    exit 1
fi

# 2. Update System Packages
echo -e "\n${CYAN}--- Step 2: Updating Debian System Repositories ---${NC}"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    curl \
    wget \
    git \
    gnupg \
    ca-certificates \
    lsb-release \
    ufw \
    jq \
    netcat-traditional \
    htop

# 3. Install Docker CE & Docker Compose Plugin
echo -e "\n${CYAN}--- Step 3: Installing Official Docker Engine & Compose ---${NC}"
if ! command -v docker &> /dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
      $CODENAME stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null

    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
        docker-compose-plugin

    systemctl enable docker
    systemctl start docker
    echo -e "${GREEN}[OK] Docker CE installed successfully.${NC}"
else
    echo -e "${GREEN}[OK] Docker is already installed: $(docker --version)${NC}"
fi

# Security Policy Notice: Docker Group vs Sudo
echo -e "\n${YELLOW}[SECURITY NOTICE - DOCKER GROUP ACCESS]${NC}"
echo -e "Adding a user to the 'docker' group grants that user ROOT-EQUIVALENT privileges."
echo -e "RECOMMENDATION: Keep Docker execution gated behind 'sudo docker compose'."
if [ "$REAL_USER" != "root" ]; then
    echo -e "User '${REAL_USER}' was NOT automatically added to the docker group for host safety."
    echo -e "If you explicitly choose convenience over strict isolation, you can manually run:"
    echo -e "  sudo usermod -aG docker ${REAL_USER}"
fi

# 4. Configure UFW Host Firewall Safely
echo -e "\n${CYAN}--- Step 4: Configuring Local Firewall (UFW) ---${NC}"

# Detect active SSH port
SSH_PORT="22"
if [ -f /etc/ssh/sshd_config ]; then
    CONFIGURED_PORT=$(grep -E "^Port [0-9]+" /etc/ssh/sshd_config | awk '{print $2}' || true)
    if [ -n "$CONFIGURED_PORT" ]; then
        SSH_PORT="$CONFIGURED_PORT"
    fi
fi

ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp" comment "SSH Remote Access"
ufw allow 80/tcp comment "Caddy HTTP (Redirect to HTTPS)"
ufw allow 443/tcp comment "Caddy HTTPS (Secure PWA Gateway)"

# Enable UFW without interactive prompt
echo "y" | ufw enable
echo -e "${GREEN}[OK] Firewall configured and enabled on SSH port ${SSH_PORT}, HTTP 80, HTTPS 443.${NC}"
ufw status verbose

# 5. Create Deployment Directory Structure
echo -e "\n${CYAN}--- Step 5: Preparing Deployment Directories ---${NC}"
DEPLOY_DIR="/opt/neptune"
mkdir -p "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR/config"
mkdir -p "$DEPLOY_DIR/data"
mkdir -p "$DEPLOY_DIR/backend"
mkdir -p "$DEPLOY_DIR/frontend/dist"
mkdir -p "$DEPLOY_DIR/scripts"

# Provide fallback placeholder config/allowed_entities.json if not present
if [ ! -f "$DEPLOY_DIR/config/allowed_entities.json" ]; then
    cat << 'EOF' > "$DEPLOY_DIR/config/allowed_entities.json"
{
  "allowed_entities": [
    "light.living_room",
    "light.kitchen",
    "light.bedroom",
    "switch.desk_fan",
    "climate.thermostat",
    "media_player.living_room_speaker",
    "media_player.vlc_telnet"
  ],
  "allowed_domains": [
    "light",
    "switch",
    "climate",
    "media_player",
    "timer",
    "sensor",
    "binary_sensor"
  ],
  "consequential_entities": [
    "lock.front_door",
    "cover.garage_door"
  ]
}
EOF
fi

# Set proper ownership for the real user to edit project files safely
if [ "$REAL_USER" != "root" ]; then
    chown -R "$REAL_USER:$REAL_USER" "$DEPLOY_DIR"
    echo -e "${GREEN}[OK] Set ownership of ${DEPLOY_DIR} to ${REAL_USER}.${NC}"
fi

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}[SUCCESS] Debian VM Bootstrap Complete!             ${NC}"
echo -e "Deployment root ready at: ${CYAN}${DEPLOY_DIR}${NC}"
echo -e "Next step: Run 'sudo docker compose up -d' in ${DEPLOY_DIR}"
echo -e "${GREEN}====================================================${NC}"
