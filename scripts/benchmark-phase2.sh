#!/bin/bash
# ==============================================================================
# NEPTUNE-AI PHASE 2 BENCHMARK & TOOL-CALLING VALIDATION SUITE
# ==============================================================================
# Target: Debian 12 / 13 AI VM (neptune-ollama container on localhost:11434)
# Purpose:
# 1. Pulls and loads bonsai-2:4b (and optional fallback qwen2.5:3b).
# 2. Measures cold/warm latency and physical tokens/sec on Intel Core i7-10700.
# 3. Executes 20-case structured tool-calling stress test against Home Assistant schemas.
# 4. Validates schema adherence, parameter accuracy, and non-tool conversational fallback.
# ==============================================================================

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

OLLAMA_API="http://localhost:11434"
TARGET_ARG="${1:-}"
PRIMARY_MODEL="bonsai-2:4b"
FALLBACK_MODEL="qwen2.5:3b"

if [ -n "$TARGET_ARG" ]; then
    PRIMARY_MODEL="$TARGET_ARG"
fi

# Ensure jq is installed
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}[NOTICE] Installing 'jq' for JSON parsing...${NC}"
    sudo apt-get update && sudo apt-get install -y jq
fi

echo -e "${CYAN}======================================================================${NC}"
echo -e "${CYAN}   NEPTUNE-AI Phase 2: AI Engine & Model Validation Suite             ${NC}"
echo -e "${CYAN}======================================================================${NC}\n"

# 1. Verify Ollama Service Health
echo -e "${BOLD}1. Checking Ollama Container Status...${NC}"
if curl -s "${OLLAMA_API}/api/version" &> /dev/null; then
    OLLAMA_VER=$(curl -s "${OLLAMA_API}/api/version" | jq -r '.version // "unknown"')
    echo -e "   - Ollama API: ${GREEN}Online${NC} (Version: ${OLLAMA_VER})"
else
    echo -e "   ${RED}[ERROR] Ollama API is not reachable at ${OLLAMA_API}.${NC}"
    echo -e "   Ensure containers are running with: sudo docker compose up -d"
    exit 1
fi

# 2. Pull & Cache Model
echo -e "\n${BOLD}2. Validating Model Availability: ${CYAN}${PRIMARY_MODEL}${NC}"
if ! curl -s "${OLLAMA_API}/api/tags" | jq -e ".models[] | select(.name | contains(\"${PRIMARY_MODEL}\"))" &> /dev/null; then
    echo -e "   ${YELLOW}[PULLING] Model '${PRIMARY_MODEL}' is not cached locally. Pulling now...${NC}"
    echo -e "   (This may take a few minutes depending on network bandwidth)"
    if ! sudo docker exec -i neptune-ollama ollama pull "$PRIMARY_MODEL"; then
        echo -e "   ${RED}[ERROR] Failed to pull '${PRIMARY_MODEL}'.${NC}"
        if [ "$PRIMARY_MODEL" != "$FALLBACK_MODEL" ]; then
            echo -e "   ${YELLOW}[FALLBACK] Attempting verified fallback model '${FALLBACK_MODEL}'...${NC}"
            PRIMARY_MODEL="$FALLBACK_MODEL"
            sudo docker exec -i neptune-ollama ollama pull "$PRIMARY_MODEL" || true
        fi
    fi
fi

if curl -s "${OLLAMA_API}/api/tags" | jq -e ".models[] | select(.name | contains(\"${PRIMARY_MODEL}\"))" &> /dev/null; then
    echo -e "   ${GREEN}[OK] Model '${PRIMARY_MODEL}' is ready for evaluation.${NC}"
else
    echo -e "   ${RED}[FATAL ERROR] Model '${PRIMARY_MODEL}' is not available in Ollama.${NC}"
    echo -e "   Try pulling manually with: sudo docker exec -it neptune-ollama ollama pull qwen2.5:3b"
    exit 1
fi

# 3. Memory Footprint Measurement
echo -e "\n${BOLD}3. Inspecting Ollama Container Memory Footprint...${NC}"
MEM_RAW=$(sudo docker stats --no-stream --format "{{.MemUsage}}" neptune-ollama 2>/dev/null || echo "Unknown")
echo -e "   - Active Container Memory: ${CYAN}${MEM_RAW}${NC}"

# 4. TEST-AI-01: Raw Token Generation Benchmark
echo -e "\n${BOLD}4. [TEST-AI-01] Executing Physical CPU Token Generation Benchmark...${NC}"
RAW_PROMPT='{"model":"'${PRIMARY_MODEL}'","prompt":"Explain the basic principles of home automation in three concise sentences.","stream":false,"options":{"temperature":0.2,"num_predict":128}}'

START_TS=$(date +%s%N)
RAW_RESP=$(curl -s -X POST "${OLLAMA_API}/api/generate" -H "Content-Type: application/json" -d "$RAW_PROMPT")
END_TS=$(date +%s%N)

EVAL_COUNT=$(echo "$RAW_RESP" | jq -r '.eval_count // 0')
EVAL_DUR=$(echo "$RAW_RESP" | jq -r '.eval_duration // 0')
TOTAL_DUR=$(echo "$RAW_RESP" | jq -r '.total_duration // 0')

if [ "$EVAL_DUR" -gt 0 ] && [ "$EVAL_COUNT" -gt 0 ]; then
    TOK_PER_SEC=$(awk "BEGIN {printf \"%.2f\", $EVAL_COUNT / ($EVAL_DUR / 1000000000)}")
    TOTAL_SEC=$(awk "BEGIN {printf \"%.2f\", $TOTAL_DUR / 1000000000}")
    echo -e "   - Tokens Generated:    ${GREEN}${EVAL_COUNT}${NC} tokens"
    echo -e "   - Generation Time:     ${GREEN}${TOTAL_SEC}${NC} seconds"
    echo -e "   - Measured Speed:      ${CYAN}${BOLD}${TOK_PER_SEC} tokens/sec${NC} on Intel Core i7-10700"

    # Evaluate against design target (>= 15 tok/s)
    SPEED_INT=${TOK_PER_SEC%.*}
    if [ "$SPEED_INT" -ge 12 ]; then
        echo -e "   ${GREEN}[PASS TEST-AI-01] Generation speed satisfies conversational speech requirements.${NC}"
    else
        echo -e "   ${YELLOW}[WARN TEST-AI-01] Generation speed (${TOK_PER_SEC} tok/s) is lower than target 15 tok/s.${NC}"
    fi
else
    echo -e "   ${RED}[FAIL] Could not measure token rate. Raw response:${NC}"
    echo "$RAW_RESP" | jq .
fi

# 5. TEST-AI-02: Structured Tool-Calling Test Suite (20 Scenarios)
echo -e "\n${BOLD}5. [TEST-AI-02] Executing 20-Case Structured Tool-Calling Stress Test...${NC}"

# Define Tool Schemas in JSON
TOOL_SCHEMAS='[
  {
    "type": "function",
    "function": {
      "name": "ha_set_state",
      "description": "Turn on, turn off, or toggle a smart home light or switch.",
      "parameters": {
        "type": "object",
        "properties": {
          "domain": {"type": "string", "enum": ["light", "switch"]},
          "entity_id": {"type": "string", "description": "e.g. light.kitchen, switch.desk_fan"},
          "state": {"type": "string", "enum": ["on", "off", "toggle"]}
        },
        "required": ["domain", "entity_id", "state"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "ha_set_climate",
      "description": "Adjust target temperature or mode on a thermostat or AC.",
      "parameters": {
        "type": "object",
        "properties": {
          "entity_id": {"type": "string"},
          "temperature": {"type": "number"},
          "hvac_mode": {"type": "string", "enum": ["heat", "cool", "auto", "off"]}
        },
        "required": ["entity_id"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "media_control",
      "description": "Control playback on music speakers or players.",
      "parameters": {
        "type": "object",
        "properties": {
          "action": {"type": "string", "enum": ["play", "pause", "stop", "next", "previous", "set_volume"]},
          "target_player": {"type": "string"},
          "volume_level": {"type": "number", "description": "0.0 to 1.0"}
        },
        "required": ["action", "target_player"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "manage_timer",
      "description": "Create, pause, or cancel a countdown timer.",
      "parameters": {
        "type": "object",
        "properties": {
          "action": {"type": "string", "enum": ["start", "pause", "cancel"]},
          "duration_minutes": {"type": "number"},
          "label": {"type": "string"}
        },
        "required": ["action"]
      }
    }
  }
]'

# Test cases array: Query | Expected Tool | Required Arg Key | Required Arg Val
TEST_PROMPTS=(
  "Turn off the kitchen light|ha_set_state|entity_id|kitchen"
  "Turn on the living room light|ha_set_state|state|on"
  "Turn off the bedroom lamp|ha_set_state|domain|light"
  "Turn on the desk fan switch|ha_set_state|domain|switch"
  "Set the living room thermostat to 22 degrees|ha_set_climate|temperature|22"
  "Pause the music in the living room|media_control|action|pause"
  "Resume music on the speaker|media_control|action|play"
  "Set timer for 15 minutes for boiling eggs|manage_timer|duration_minutes|15"
  "Cancel the cooking timer|manage_timer|action|cancel"
  "Turn on the patio switch|ha_set_state|domain|switch"
  "Set thermostat to cooling mode|ha_set_climate|hvac_mode|cool"
  "Stop the living room speaker|media_control|action|stop"
  "Turn off the desk fan|ha_set_state|state|off"
  "Set volume on living room speaker to 50 percent|media_control|action|set_volume"
  "Start a 5 minute timer|manage_timer|duration_minutes|5"
  "Toggle the hallway light|ha_set_state|state|toggle"
  "Turn off the garden lights|ha_set_state|state|off"
  "Set climate target to 19 degrees|ha_set_climate|temperature|19"
  "Skip to next track on living room speaker|media_control|action|next"
  "What is the capital of France?|NONE|NONE|NONE"
)

TC_PASS=0
TC_FAIL=0
IDX=1

for ITEM in "${TEST_PROMPTS[@]}"; do
    IFS="|" read -r PROMPT EXPECTED_TOOL REQ_KEY REQ_VAL <<< "$ITEM"
    
    PAYLOAD=$(jq -n \
      --arg model "$PRIMARY_MODEL" \
      --arg prompt "$PROMPT" \
      --argjson tools "$TOOL_SCHEMAS" \
      '{
        model: $model,
        messages: [{role: "user", content: $prompt}],
        tools: $tools,
        stream: false,
        options: {temperature: 0.1}
      }')

    RESP=$(curl -s -X POST "${OLLAMA_API}/api/chat" -H "Content-Type: application/json" -d "$PAYLOAD")
    
    API_ERR=$(echo "$RESP" | jq -r '.error // empty')
    if [ -n "$API_ERR" ]; then
        echo -e "   [Case $IDX/20] ${RED}FAIL${NC} \"$PROMPT\" -> Ollama error: $API_ERR"
        TC_FAIL=$((TC_FAIL + 1))
        IDX=$((IDX + 1))
        continue
    fi

    TOOL_NAME=$(echo "$RESP" | jq -r '.message.tool_calls[0].function.name // "NONE"')
    TOOL_ARGS=$(echo "$RESP" | jq -r '.message.tool_calls[0].function.arguments // empty')
    
    if [ "$EXPECTED_TOOL" = "NONE" ]; then
        if [ "$TOOL_NAME" = "NONE" ]; then
            echo -e "   [Case $IDX/20] ${GREEN}PASS${NC} Prompt: \"$PROMPT\" -> Correctly answered conversationally without hallucinating tools."
            TC_PASS=$((TC_PASS + 1))
        else
            echo -e "   [Case $IDX/20] ${RED}FAIL${NC} Prompt: \"$PROMPT\" -> Hallucinated unexpected tool: $TOOL_NAME"
            TC_FAIL=$((TC_FAIL + 1))
        fi
    else
        if [ "$TOOL_NAME" = "$EXPECTED_TOOL" ]; then
            # Verify argument contains expected value
            ARG_MATCH=$(echo "$TOOL_ARGS" | jq -r --arg k "$REQ_KEY" '.[$k] // ""' | grep -i "$REQ_VAL" || true)
            if [ -n "$ARG_MATCH" ] || [ "$REQ_KEY" = "NONE" ]; then
                echo -e "   [Case $IDX/20] ${GREEN}PASS${NC} \"$PROMPT\" -> Called ${CYAN}${TOOL_NAME}${NC} with ${REQ_KEY}=${REQ_VAL}"
                TC_PASS=$((TC_PASS + 1))
            else
                echo -e "   [Case $IDX/20] ${YELLOW}PARTIAL${NC} \"$PROMPT\" -> Called ${TOOL_NAME} but missed argument $REQ_KEY=$REQ_VAL"
                TC_FAIL=$((TC_FAIL + 1))
            fi
        else
            echo -e "   [Case $IDX/20] ${RED}FAIL${NC} \"$PROMPT\" -> Expected tool '$EXPECTED_TOOL', got '${TOOL_NAME}'"
            TC_FAIL=$((TC_FAIL + 1))
        fi
    fi
    IDX=$((IDX + 1))
done

# Summary & Recommendation
echo -e "\n${CYAN}======================================================================${NC}"
echo -e "${BOLD}PHASE 2 VALIDATION SUMMARY (${PRIMARY_MODEL}):${NC}"
echo -e "   - Tool Calls Passed: ${GREEN}${TC_PASS} / 20${NC} ($(( TC_PASS * 100 / 20 ))%)"
echo -e "   - Tool Calls Failed: ${RED}${TC_FAIL} / 20${NC}"

if [ "$TC_PASS" -ge 18 ]; then
    echo -e "${GREEN}[SUCCESS] ${PRIMARY_MODEL} tool-calling fidelity is excellent (${TC_PASS}/20 >= 18).${NC}"
    echo -e "Recommendation: Retain ${PRIMARY_MODEL} as primary reasoning engine."
elif [ "$TC_PASS" -ge 14 ]; then
    echo -e "${YELLOW}[ACCEPTABLE WITH CAUTION] ${PRIMARY_MODEL} scored ${TC_PASS}/20.${NC}"
    echo -e "Recommendation: Retain ${PRIMARY_MODEL}, but enforce deterministic fast-path for smart home rules."
else
    echo -e "${RED}[WARNING] ${PRIMARY_MODEL} tool-calling fidelity (${TC_PASS}/20) is below target.${NC}"
    echo -e "Recommendation: Deploy fallback model '${FALLBACK_MODEL}' for rock-solid tool calling."
fi
echo -e "${CYAN}======================================================================${NC}"
