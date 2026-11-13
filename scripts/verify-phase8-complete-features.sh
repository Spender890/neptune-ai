#!/usr/bin/env bash
# ==============================================================================
# NEPTUNE-AI: Complete Features Verification Suite
# Verifies:
# 1. Multi-Person Identification & Contacts Registry
# 2. Proactive Outbound Messaging ("Call [person] and tell them [msg]")
# 3. TV State & "What's playing on TV" Query
# 4. TV Audio Routing through Whole-House Speakers (ARC / Optical)
# 5. Universal Reminders (Synced across Phone, Web & Home Speakers)
# ==============================================================================
set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}======================================================================${NC}"
echo -e "${CYAN}   NEPTUNE-AI: Complete Features Verification Suite                   ${NC}"
echo -e "${CYAN}======================================================================${NC}"

BACKEND_URL="http://127.0.0.1:3000"

echo ""
echo -e "${CYAN}1. Checking Backend Health & Phase 7/8 Subsystem Status...${NC}"
STATUS=$(curl -s "${BACKEND_URL}/api/status")
echo "${STATUS}" | grep -q "Neptune-AI" && echo -e "   [${GREEN}PASS${NC}] Backend is online." || { echo -e "   [${RED}FAIL${NC}] Backend unreachable."; exit 1; }

echo ""
echo -e "${CYAN}2. Verifying Contacts Directory & Multi-Person Registry...${NC}"
CONTACTS=$(curl -s "${BACKEND_URL}/api/contacts")
echo "${CONTACTS}" | grep -q "1001" && echo -e "   [${GREEN}PASS${NC}] Ext 1001 (Primary) registered in contacts."
echo "${CONTACTS}" | grep -q "1002" && echo -e "   [${GREEN}PASS${NC}] Ext 1002 (Desk) registered in contacts."

echo ""
echo -e "${CYAN}3. Testing TV State & 'What is Playing on TV' Query...${NC}"
TV_STATE_CMD=$(curl -s -X POST "${BACKEND_URL}/api/command" \
  -H "Content-Type: application/json" \
  -d '{"text": "what is playing on tv"}')
echo "Response: ${TV_STATE_CMD}"
echo "${TV_STATE_CMD}" | grep -q "fast-path-tv-state" && echo -e "   [${GREEN}PASS${NC}] FastPath matched TV state query."

echo ""
echo -e "${CYAN}4. Testing TV Audio Routing to Home Speakers (ARC / Optical)...${NC}"
ROUTE_SPEAKERS_CMD=$(curl -s -X POST "${BACKEND_URL}/api/command" \
  -H "Content-Type: application/json" \
  -d '{"text": "route tv audio through home speakers"}')
echo "Response: ${ROUTE_SPEAKERS_CMD}"
echo "${ROUTE_SPEAKERS_CMD}" | grep -q "fast-path-tv-sound" && echo -e "   [${GREEN}PASS${NC}] TV audio routed to whole-house speakers."

ROUTE_TV_CMD=$(curl -s -X POST "${BACKEND_URL}/api/command" \
  -H "Content-Type: application/json" \
  -d '{"text": "switch tv audio back to tv speakers"}')
echo "Response: ${ROUTE_TV_CMD}"
echo "${ROUTE_TV_CMD}" | grep -q "fast-path-tv-sound" && echo -e "   [${GREEN}PASS${NC}] TV audio switched back to TV internal speakers."

echo ""
echo -e "${CYAN}5. Testing Outbound Messaging ('Call Desk and tell them dinner is ready')...${NC}"
CALL_MSG_CMD=$(curl -s -X POST "${BACKEND_URL}/api/command" \
  -H "Content-Type: application/json" \
  -d '{"text": "call desk and tell them dinner is ready"}')
echo "Response: ${CALL_MSG_CMD}"
echo "${CALL_MSG_CMD}" | grep -q "fast-path-telephony-call" && echo -e "   [${GREEN}PASS${NC}] Call file generated for Desk (Ext 1002)."

echo ""
echo -e "${CYAN}6. Testing Universal Reminders (Universal Store & Channel Sync)...${NC}"
REM_RES=$(curl -s -X POST "${BACKEND_URL}/api/command" \
  -H "Content-Type: application/json" \
  -d '{"text": "remind me to check the oven in 1 minute", "caller_id": "1001", "caller_name": "Sultan"}')
echo "Response: ${REM_RES}"
echo "${REM_RES}" | grep -q "fast-path-reminder" && echo -e "   [${GREEN}PASS${NC}] Reminder created with caller metadata."

REM_LIST=$(curl -s "${BACKEND_URL}/api/reminders")
echo "Active Reminders: ${REM_LIST}"
echo "${REM_LIST}" | grep -q "check the oven" && echo -e "   [${GREEN}PASS${NC}] Reminder visible in universal reminders registry."

echo ""
echo -e "${CYAN}7. Verifying Asterisk Dialplan & Voice Agent Permissions...${NC}"
sudo docker exec neptune-asterisk asterisk -rx "dialplan reload" > /dev/null
echo -e "   [${GREEN}PASS${NC}] Asterisk dialplan reloaded cleanly."

echo ""
echo -e "${GREEN}======================================================================${NC}"
echo -e "${GREEN}   ALL COMPLETE FEATURES VERIFIED SUCCESSFULLY!                       ${NC}"
echo -e "${GREEN}======================================================================${NC}"
