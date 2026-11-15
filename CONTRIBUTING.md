# Contributing to Neptune-AI

Thank you for your interest in contributing to **Neptune-AI**! Because Neptune-AI orchestrates local AI inference, home automation, and SIP telephony hardware on local networks, reliability, input validation, and clear boundaries between deterministic rules and LLM reasoning are top priorities.

---

## 1. Development Setup

### Prerequisites
- **Node.js `20.18.1` (LTS)** and **npm** (matches `backend/Dockerfile`) — *or Node `>= 22.6` if running native TypeScript tests without `tsc`*
- **Python `3.11+`** (standard library only required for tests)
- **Git** and **Docker / Docker Compose v2** (optional, required for full stack or container build verification)

### One-Step Local Dev Setup
```bash
git clone https://github.com/Spender890/neptune-ai.git
cd neptune-ai

# 1. Create local environment & example config copies (do not commit secrets)
cp .env.example .env
cp config/contacts.json.example config/contacts.json

# 2. Install backend TypeScript dependencies
cd backend
npm install
cd ..
```

---

## 2. Running Tests & Linting

- **Canonical Backend Lint / Typecheck Command:**
  ```bash
  cd backend && npm run lint
  ```
- **Canonical Test Command (Full CI Parity):**
  ```bash
  cd backend && npm run build && npm test && cd .. && python3 -m unittest discover -s tests -v
  ```
- **Fast Backend-Only Tests on Node `>= 22.6` (no compile step):**
  ```bash
  node --import ./backend/test/ts-loader.mjs --test backend/test/neptune.test.ts
  ```
- **Python Syntax & Voice Benchmark Checks:**
  ```bash
  python3 -m py_compile scripts/asterisk-voice-agent.py scripts/benchmark-voice-phase3.py tests/test_neptune_python.py
  bash -n scripts/*.sh
  ```

---

## 3. Code Style & Module Architecture

### Code Formatting & Conventions
- **TypeScript (`backend/src/`):** Strict mode (`strict: true`), CommonJS target for Node 20 runtime compatibility, 2-space indentation, single quotes, semicolons, explicit return/interface types, and **inline `type` imports** (`import { X, type Y } from './mod'`) so both `tsc` and native Node TypeScript execution succeed without type-stripping errors.
- **No external runtime test frameworks:** All Node tests use `node:test` and `node:assert/strict`; all Python tests use standard library `unittest`.
- **HTTP calls:** Always route outbound HTTP/HTTPS requests through `performHttpRequest` in `backend/src/httpClient.ts` so TLS (`https://`), timeouts, and `setHttpRequester` unit mocks work uniformly.
- **Security boundaries:** Every Home Assistant call from either FastPath or the LLM **must** pass through `PermissionsGateway.validate()`. Never weaken `consequential_entities` confirmation gating.

### Repository Layout
```text
neptune-ai/
├── backend/src/
│   ├── engine.ts         # Core NeptuneEngine coordinator, validation, config loader, tool schemas
│   ├── index.ts          # Fastify server bootstrap, API key auth hook, routes, Agenda timer
│   ├── fastpath.ts       # Deterministic regex router (<1ms local CPU, evaluated before Ollama)
│   ├── permissions.ts    # Allowlist + consequential entity security gateway
│   ├── ollama.ts         # Ollama /api/chat tool-calling & conversational fallback client
│   ├── homeassistant.ts  # Home Assistant REST API client
│   ├── jellyfin.ts       # Jellyfin search & remote playback client
│   ├── webos.ts          # LG webOS TV + Jellyfin orchestration + speaker output fallback
│   ├── contacts.ts       # Directory resolver (extension / name / alias)
│   ├── reminders.ts      # Atomic JSON store (reminders.json)
│   ├── agenda.ts         # 5-second background scheduler triggering TV, speakers, Asterisk calls
│   ├── telephony.ts      # Asterisk .call file generator with emergency/external blocking
│   └── httpClient.ts     # Shared HTTP/HTTPS client with timeout & test mock hook
├── scripts/              # Asterisk Python AGI bridge, Debian/Proxmox setup, verification & benchmarks
├── config/               # Entity allowlist & contact directory templates
├── asterisk/             # Asterisk 20 PJSIP, dialplan, RTP configs & Dockerfile
├── frontend/dist/        # Static Web Cockpit UI served by Caddy
└── tests/                # Python unittest suite
```

---

## 4. Walkthrough: Adding a New Integration or Intent

Follow this pattern when adding a new device integration (for example, a **garage camera snapshot** or **vacuum control**):

1. **Create or extend a focused client module (`backend/src/myintegration.ts`):**
   - Use `performHttpRequest` from `./httpClient`.
   - Validate identifiers (`domain`, `entity_id`, host inputs) with strict regexes and `encodeURIComponent`.
2. **Enforce safety in `config/allowed_entities.json` & `backend/src/permissions.ts`:**
   - Add deterministic commands to `FastPathRouter.match()` in `backend/src/fastpath.ts` so critical actions cannot be misinterpreted by a small local LLM.
   - If the action has physical security risk (doors, locks, alarms, external relays), add it to `consequential_entities` and set `requires_confirmation: true`.
3. **Wire the execution path and optional LLM tool schema in `backend/src/engine.ts`:**
   - Add an intent handler branch in `NeptuneEngine.handleCommand()` for the FastPath intent.
   - Optionally expose a narrow JSON tool schema in `TOOL_SCHEMAS` and validate arguments before calling `PermissionsGateway.validate()`.
4. **Write deterministic tests in `backend/test/neptune.test.ts`:**
   - Add unit tests for `FastPathRouter.match()` and mock HTTP integration tests via `setHttpRequester(...)` covering both success and upstream timeout/error paths.

---

## 5. Pull Request Process

1. Fork the repository and create a topic branch from `main` (e.g., `fix/ha-timeout-handling` or `feat/fastpath-blinds`).
2. Keep PRs focused and small; preserve unrelated comments and docstrings.
3. Add or update unit/mock-integration tests covering any changed logic.
4. Run the lint and test commands locally and verify `.github/workflows/ci.yml` passes on your PR.
5. Complete the PR checklist in `.github/PULL_REQUEST_TEMPLATE.md`, explicitly distinguishing **verified local unit/mock checks** from **unverified hardware/container checks** if you lack physical appliances.

---

## 6. Beginner-Friendly Contribution Ideas ("Good First Issues")

These are real, unimplemented improvements identified during the `v0.1.0` readiness audit:

1. **Interactive Web Confirmation Modal (`frontend/dist/index.html` + `/api/confirm` endpoint):** Today `requires_confirmation: true` returns a `4xx/200` preview response without executing locks/covers, rather than a two-step signed/tokenized confirmation endpoint for Web UI approval.
2. **Real-Time Browser Voice Capture (`frontend/dist/index.html` + `/api/voice`):** Wire the existing Push-to-Talk UI button to `MediaRecorder` / Web Audio upload and backend `/api/voice` forwarding to Wyoming Whisper & Piper.
3. **Structured Logger Migration (`backend/src/*`):** Replace `console.log`/`console.error` calls with a lightweight structured JSON logger that scrubs `HOMEASSISTANT_TOKEN`, `JELLYFIN_API_KEY`, and `NEPTUNE_API_KEY`.
4. **ESLint & Prettier Config (`backend/`):** Add an explicit `.eslintrc` / Prettier config alongside `tsc --noEmit` to enforce uniform formatting automatically in CI.
5. **SIP Dialer Target Validation Endpoint Tests:** Expand `tests/test_neptune_python.py` to cover multi-turn AGI conversation history truncation and Asterisk temp `.wav` cleanup on failure.
6. **Home Assistant Entity Discovery Helper (`scripts/`):** Write a read-only setup helper script that queries `/api/states` with a user's `HOMEASSISTANT_TOKEN` to suggest entries for `config/allowed_entities.json`.
7. **Persistent SQLite / Append-Only Audit Log Option (`backend/src/`):** Implement optional audit logging of FastPath/LLM decisions with automatic log rotation without blocking command latency.
8. **Internationalization / Custom Unit Support in `FastPathRouter`:** Make thermostat temperature units (Celsius vs. Fahrenheit validation bounds) configurable via environment variables.
