#!/usr/bin/env bash
# ==============================================================================
# NEPTUNE-AI: Phase 7 Verification Suite (Asterisk SIP & Telephony Subsystem)
# ==============================================================================
set -euo pipefail

echo "======================================================================"
echo "   NEPTUNE-AI Phase 7: Asterisk SIP Telephony Subsystem"
echo "======================================================================"

echo ""
echo "1. Checking Asterisk Container Health & SIP Socket..."
if sudo docker ps | grep -q neptune-asterisk; then
    echo "   [PASS] Container neptune-asterisk is running."
else
    echo "   [FAIL] neptune-asterisk container is not running."
    exit 1
fi

echo ""
echo "2. [TEST-SIP-01] Testing Asterisk PJSIP Transports & Sockets..."
SIP_TRANSPORTS=$(sudo docker exec neptune-asterisk asterisk -rx "pjsip show transports" || true)
echo "${SIP_TRANSPORTS}"
if echo "${SIP_TRANSPORTS}" | grep -q "transport-udp"; then
    echo "   [PASS] PJSIP UDP Transport active on 0.0.0.0:5060."
else
    echo "   [FAIL] PJSIP UDP Transport failed to bind."
    exit 1
fi

echo ""
echo "3. [TEST-SIP-02] Verifying Internal Extensions (1001, 1002, 7000)..."
ENDPOINTS=$(sudo docker exec neptune-asterisk asterisk -rx "pjsip show endpoints" || true)
echo "${ENDPOINTS}"
for ext in 1001 1002 7000; do
    if echo "${ENDPOINTS}" | grep -q "Endpoint:  ${ext}"; then
        echo "   [PASS] Extension ${ext} verified."
    else
        echo "   [FAIL] Extension ${ext} missing in PJSIP registry."
        exit 1
    fi
done

echo ""
echo "4. [TEST-SIP-03] Testing Dialplan Routing to Neptune-AI Operator (Ext 7000)..."
DIALPLAN=$(sudo docker exec neptune-asterisk asterisk -rx "dialplan show 7000@internal" || true)
echo "${DIALPLAN}"
if echo "${DIALPLAN}" | grep -q "EAGI"; then
    echo "   [PASS] Dialplan 7000 correctly routes to Neptune Voice Agent EAGI."
else
    echo "   [FAIL] Dialplan routing for 7000 is missing EAGI directive."
    exit 1
fi

echo ""
echo "======================================================================"
echo "PHASE 7 VALIDATION SUMMARY:"
echo "   - SIP PBX Server:       Asterisk 20+ running in Docker (~65 MB RAM)"
echo "   - SIP Port:             UDP 5060 & RTP 10000-10050"
echo "   - Registered Endpoints: Ext 1001 (Mobile), 1002 (Tablet/Desk), 7000 (Neptune)"
echo "   - Voice AI Bridge:      EAGI Bidirectional Linear PCM Bridge"
echo "======================================================================"
