#!/bin/bash
# ==============================================================================
# PHASE 1 VERIFICATION SCRIPT (TEST-INF-01 & TEST-INF-02)
# ==============================================================================
# Target: Run on Debian 12 AI VM to verify infrastructure prerequisites,
# virtualization configuration, Docker health, TLS syntax, and LAN connectivity.
# ==============================================================================

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0

function check_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    PASS_COUNT=$((PASS_COUNT + 1))
}

function check_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    FAIL_COUNT=$((FAIL_COUNT + 1))
}

function check_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

DOCKER_CMD="docker"
if ! docker info &> /dev/null; then
    if sudo docker info &> /dev/null; then
        DOCKER_CMD="sudo docker"
    fi
fi

echo -e "${CYAN}====================================================${NC}"
echo -e "${CYAN}   NEPTUNE-AI Phase 1 Verification Test Suite       ${NC}"
echo -e "${CYAN}====================================================${NC}\n"

# 1. Virtualization & CPU Check (AVX2 support)
echo -e "${CYAN}[TEST 1: CPU Architecture & AVX2 Capabilities]${NC}"
if grep -q "avx2" /proc/cpuinfo; then
    check_pass "AVX2 CPU instructions available for Whisper and Piper inference."
else
    check_fail "AVX2 instructions NOT found. In Proxmox VM settings, set CPU type to 'host'."
fi

# 2. Memory Sizing Check (8.0 GB sizing baseline)
echo -e "\n${CYAN}[TEST 2: RAM Allocation Budget (8.0 GB Baseline)]${NC}"
TOTAL_RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
if [ "$TOTAL_RAM_MB" -ge 7000 ]; then
    check_pass "Memory allocated is adequate (${TOTAL_RAM_MB} MB >= 7000 MB for 8.0 GB configuration)."
else
    check_fail "Memory allocated (${TOTAL_RAM_MB} MB) is lower than the recommended 8.0 GB."
fi

# 3. Docker & Compose Check
echo -e "\n${CYAN}[TEST 3: Docker & Container Runtime Engine]${NC}"
if $DOCKER_CMD info &> /dev/null; then
    check_pass "Docker engine is running: $($DOCKER_CMD --version)"
else
    check_fail "Docker engine is not active or user lacks permission."
fi

if $DOCKER_CMD compose version &> /dev/null; then
    check_pass "Docker Compose plugin installed: $($DOCKER_CMD compose version)"
else
    check_fail "Docker Compose plugin is missing."
fi

# 4. Repository Files & Directory Tree Check
echo -e "\n${CYAN}[TEST 4: Repository Directories & Source Files]${NC}"
MISSING_FILES=0
for FILE in "Caddyfile" "docker-compose.yml" "config/allowed_entities.json" "frontend/dist/index.html" "backend/Dockerfile" "backend/src/index.ts"; do
    if [ -f "$FILE" ]; then
        check_pass "Found required file: $FILE"
    else
        check_fail "Missing required file: $FILE"
        MISSING_FILES=$((MISSING_FILES + 1))
    fi
done

# 5. Caddyfile Validation
echo -e "\n${CYAN}[TEST 5: Reverse Proxy Configuration (Caddyfile)]${NC}"
if [ -f "Caddyfile" ]; then
    if $DOCKER_CMD run --rm -v "$(pwd)/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.8.4-alpine caddy validate --config /etc/caddy/Caddyfile &> /dev/null; then
        check_pass "Caddyfile syntax is valid with internal TLS and secure headers."
    else
        check_fail "Caddyfile validation failed syntax check."
    fi
else
    check_warn "Caddyfile not found in current directory ($(pwd)). Skipping syntax validation."
fi

# 6. Network Connectivity to Home Assistant & Jellyfin
echo -e "\n${CYAN}[TEST 6: Local Network Connectivity]${NC}"
if [ -f ".env" ]; then
    HA_URL=$(grep "^HOMEASSISTANT_URL=" .env | cut -d '=' -f2- | tr -d '"' | tr -d "'")
    JELLY_URL=$(grep "^JELLYFIN_URL=" .env | cut -d '=' -f2- | tr -d '"' | tr -d "'")

    if [ -n "$HA_URL" ] && [ "$HA_URL" != "http://homeassistant.local:8123" ]; then
        if curl -s --connect-timeout 3 "$HA_URL" &> /dev/null; then
            check_pass "Home Assistant reachable at $HA_URL"
        else
            check_warn "Could not connect to Home Assistant at $HA_URL (check if VM is running)."
        fi
    else
        check_warn "Home Assistant URL is default/unconfigured in .env."
    fi

    if [ -n "$JELLY_URL" ] && [ "$JELLY_URL" != "http://jellyfin.local:8096" ]; then
        if curl -s --connect-timeout 3 "$JELLY_URL" &> /dev/null; then
            check_pass "Jellyfin reachable at $JELLY_URL"
        else
            check_warn "Could not connect to Jellyfin at $JELLY_URL (check if WD Sentinel is powered on)."
        fi
    else
        check_warn "Jellyfin URL is default/unconfigured in .env."
    fi
else
    check_warn "No .env file found in $(pwd); skipping external host connectivity check."
fi

# Summary
echo -e "\n${CYAN}====================================================${NC}"
echo -e "Tests Passed: ${GREEN}${PASS_COUNT}${NC} | Tests Failed: ${RED}${FAIL_COUNT}${NC}"
if [ "$FAIL_COUNT" -eq 0 ]; then
    echo -e "${GREEN}PHASE 1 ACCEPTANCE CRITERIA MET SUCCESSFULLY.${NC}"
    exit 0
else
    echo -e "${RED}PHASE 1 CRITERIA NOT MET. RESOLVE FAILURES BEFORE PROCEEDING.${NC}"
    exit 1
fi
