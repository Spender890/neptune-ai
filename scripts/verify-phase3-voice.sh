#!/bin/bash
# ==============================================================================
# NEPTUNE-AI PHASE 3: NEURAL VOICE SUBSYSTEM VERIFICATION SUITE
# ==============================================================================
# Verifies:
# 1. Wyoming Piper TTS (10200) - Time-to-First-Audio & Real-Time Factor
# 2. Wyoming Whisper STT (10300) - Turnaround latency & Word Accuracy
# 3. End-to-End Voice Loop (Utterance -> Whisper -> Qwen 2.5 3B -> Piper)
# 4. Optional physical AUX playback to whole-house amplifier
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_SCRIPT="${SCRIPT_DIR}/benchmark-voice-phase3.py"

echo -e "${CYAN}======================================================================${NC}"
echo -e "${CYAN}   NEPTUNE-AI Phase 3: Neural Voice Subsystem Verification             ${NC}"
echo -e "${CYAN}======================================================================${NC}\n"

# 1. Check Python3 presence
if ! command -v python3 &> /dev/null; then
    echo -e "${YELLOW}[NOTICE] Installing python3...${NC}"
    sudo apt-get update && sudo apt-get install -y python3 alsa-utils
fi

# 2. Check if ports 10200 and 10300 are reachable on loopback
if ! nc -z 127.0.0.1 10200 2>/dev/null || ! nc -z 127.0.0.1 10300 2>/dev/null; then
    echo -e "${YELLOW}[NOTICE] Loopback ports 10200/10300 not yet bound on host.${NC}"
    echo -e "Applying docker-compose port bindings for whisper and piper..."
    cd /opt/neptune
    sudo docker compose up -d whisper piper
    sleep 2
fi

# 3. Execute the Python Voice Benchmark Harness
python3 "$PYTHON_SCRIPT"

echo -e "\n${BOLD}Phase 3 Acceptance Criteria Summary:${NC}"
echo -e "   - Whisper STT Turnaround:  Target <= 450 ms"
echo -e "   - Piper TTS Turnaround:    Target <= 200 ms (RTF < 0.25)"
echo -e "   - Voice Roundtrip Latency: Target <= 1.8 s (Streaming Sentence Synthesis)"
echo -e "${CYAN}======================================================================${NC}"
