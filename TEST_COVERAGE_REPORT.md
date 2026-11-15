# Neptune-AI Test Coverage Report

**Date:** 2026-11-15  
**Version Evaluated:** `v0.1.0`  
**Methodology Notice:** Every local test reported below was executed directly after code hardening on the Windows audit host (`Node v26.13.0` + `Python 3.15.1`). Hardware, LAN appliances, and live Docker container stacks could **not** be executed on this Windows host and are explicitly separated under [Unverified Live & Hardware Tests](#4-unverified-live-container--hardware-tests).

---

## 1. Executive Summary: Baseline vs. Post-Remediation

| Suite / Verification Check | Baseline (`9af7de9`) | Post-Remediation (`v0.1.0`) | Notes |
| :--- | :--- | :--- | :--- |
| Backend Automated Unit & Mock Integration (`backend/test/neptune.test.ts`) | **0 tests** (no test directory existed) | **17 tests across 8 suites passed (0 failed)** | Executed via `node --import ./backend/test/ts-loader.mjs --test backend/test/neptune.test.ts` |
| Python Voice Pipeline & Repo Security (`tests/test_neptune_python.py`) | **0 tests** (no `tests/` directory existed) | **13 tests passed (0 failed)** | Executed in `0.007s` via `python -m unittest discover -s tests -v` |
| FastPath CPU Microbenchmark (`scripts/benchmark-fastpath.ts`) | Not present | **10,000 iterations passed (0 errors)** | Mean `1.05 us`, p95 `1.90 us`, p99 `2.80 us` |
| Python Byte-Compilation (`py_compile`) | Passed (2 scripts) | Passed (`asterisk-voice-agent.py`, `benchmark-voice-phase3.py`, `tests/test_neptune_python.py`) | Exit code `0` |
| JSON Schema / Config Parsing | Passed (4 files) | Passed (validated inside `test_json_configs_are_valid`) | Covers `allowed_entities.json`, `contacts.json.example`, `package.json`, `tsconfig*.json` |
| TypeScript Compiler (`tsc` / `tsc --noEmit`) | Failed (`npm`/`tsc` absent on host) | **Not run locally** (configured in GitHub Actions `ci.yml`) | Awaits CI or Linux container build (`npm` absent & `backend/node_modules` not installed locally) |
| Live Container / Hardware / Shell Acceptance (`scripts/verify-phase*.sh`) | Not runnable (no Docker / bash runtime in sandbox) | **Not run locally** | Requires Linux/Debian VM + HAOS + Ollama + Asterisk + LG TV |

---

## 2. Backend TypeScript Test Matrix (`backend/test/neptune.test.ts`)

Uses Node's built-in `node:test` and `node:assert/strict` with an in-memory `setHttpRequester` hook (`backend/src/httpClient.ts`) and temporary directories (`fs.mkdtempSync`). **Does not require Fastify `node_modules` on disk** during type-stripped unit execution except where route registration accepts a mock Fastify app instance (`require('fastify')` only runs when `createServer()` is called).

| Test Suite | Test Cases Covered | Verification Mode | Status |
| :--- | :--- | :--- | :--- |
| `FastPathRouter` (6 tests) | Light/switch toggle matching; custom `TV_ENTITY_ID` / `SPEAKER_ENTITY_ID` injection; TV audio routing (`external_arc` / `tv_speaker`), playback controls, volume clamping (`150` -> `1`), apps, Jellyfin play, TV toast; climate, outbound SIP call messages, reminder/timer parsing & non-positive duration rejection; deterministic `ha_lock` / `ha_cover` matching (`requires_confirmation: true`); conversational fallback, whitespace & >500-char boundary rejection | Pure unit | PASS (6/6) |
| `PermissionsGateway` (1 test) | Exact entity match; explicit trailing `*` wildcard (`light.bedroom_*`); implicit prefix bypass prevention (`light.kitchen_override` denied); `consequential_entities` evaluated before `allowed_domains` (`lock.front_door`, `cover.garage_door` -> `requires_confirmation: true`); disallowed domain denial (`automation.evil`); regex rejection of path-traversal IDs (`../api`, `light.kitchen/../../secrets`) | Pure unit + temp JSON config | PASS (1/1) |
| `Contacts Directory & Resolution` (1 test) | Custom contacts loading; alias resolution (`my phone` -> `1001`); punctuation-stripped resolution (`Desk!` -> `1002`); reverse extension lookup; unknown target returns `undefined` | Pure unit + temp JSON file | PASS (1/1) |
| `ReminderStore & AgendaDaemon` (2 tests) | Atomic save/reload cycle; newline scrubbing in titles; invalid empty/zero/negative duration rejection; reminder deletion; `AgendaDaemon.tick()` re-entrancy guard under `Promise.all([tick(), tick()])`; HA TV/speaker dispatch verification; Asterisk `.call` injection escaping (`\nApplication:` stripped) | Mocked HTTP (`setHttpRequester`) + temp spool dir | PASS (2/2) |
| `TelephonyManager Security` (1 test) | Sanitized `.call` file creation for valid contacts; emergency number block (`911` rejected); unmapped external number block (`15551234567` rejected) | Pure unit + temp spool dir | PASS (1/1) |
| `HttpClient & Upstream Clients` (2 tests) | HTTP vs HTTPS transport selection (`node:http` vs `node:https`); unsupported `ftp://` protocol rejection; invalid HA domain/service identifier rejection (`../evil`); upstream timeout propagation in `HomeAssistantClient` and `OllamaAgent` | Unit + mocked `setHttpRequester` | PASS (2/2) |
| `NeptuneEngine End-to-End Mock Routing` (1 test) | FastPath light control with HA Bearer auth and zero Ollama calls; FastPath consequential lock never calls HA; TV state combining HA + Jellyfin session metadata; Jellyfin search + TV session playback; LLM tool calling (`ha_set_state`) on allowed entities; LLM tool call targeting `consequential_entities` blocked with `requires_confirmation: true`; LLM conversational fallback; HTTP 400 validation errors (`''`, `1001`-char command, invalid `sound_output`, negative reminder duration) | Mock integration (mocked HA, Jellyfin, Ollama HTTP responses) | PASS (1/1) |
| `API Auth & Route Registration` (1 test) | `verifyApiKey` across empty key mode, `X-API-Key`, `Authorization: Bearer`, mismatched key, missing header; `registerRoutes` verifying `onRequest` auth hook and all 10 Fastify endpoints (`/api/health`, `/api/command`, `/api/reminders`, `/api/reminders/:id`, `/api/telephony/call`, `/api/tv/sound-output`, etc.) | Unit + mock Fastify app object | PASS (1/1) |

---

## 3. Python & Repository Invariant Test Matrix (`tests/test_neptune_python.py`)

Uses Python standard library `unittest` and `unittest.mock` with in-memory stream/socket doubles (`FakeBlockingSocket`, `FakeAsyncReader`, `FakeAsyncWriter`) so all tests run deterministically offline and without Windows sandbox socket errors.

| Test Class | Test Methods Covered | Verification Mode | Status |
| :--- | :--- | :--- | :--- |
| `TestWyomingVoicePipeline` (3 tests) | `send_wyoming_event` / `read_wyoming_event` roundtrip with payload framing; EOF & malformed JSON resilience; `convert_wav_to_16k_mono` verification for 16kHz passthrough, 22.05kHz mono downsampling, and 48kHz stereo-to-mono downsampling | Pure unit + in-memory socket double | PASS (3/3) |
| `TestAsteriskVoiceAgent` (5 tests) | AGI env parsing & caller extension mapping (`1002` -> `Desk`, `9999` -> `Caller`); `is_hangup_intent` word-boundary check ensuring `"stop the living room tv"` does **not** hang up while `"stop"` / `"Goodbye!"` / `"Please hang up now"` do; `_sanitize_agi_arg` newline/CR/NUL stripping; `StdlibWyomingClient` async STT (`transcribe`, `audio-start`, `audio-chunk`, `audio-stop`) & TTS (`synthesize`, `audio-start`, `audio-chunk`, `audio-stop`) fallback; `query_backend` `X-API-Key` forwarding and error fallback message | Unit + mocked `asyncio.open_connection` & `urllib.request.urlopen` | PASS (5/5) |
| `TestRepositoryConfigAndSecurity` (5 tests) | Validity of all 5 tracked JSON config/project files; `docker-compose.yml` image pinning (`>=6` images, zero `:latest`, `>=6` healthchecks); presence of `escapeHtml()` & absence of inline `onclick="deleteReminder(...)"` XSS pattern in `frontend/dist/index.html`; `.env.example` & `asterisk/pjsip.conf` placeholder credential verification; `0.1.0` version consistency across `backend/package.json` & `backend/src/engine.ts` | Static / invariant check | PASS (5/5) |

---

## 4. Unverified Live Container & Hardware Tests

The following paths **cannot be verified** in this offline Windows audit workspace and **must NOT be inferred as passing**:

1. **`tsc` compilation & Fastify runtime HTTP server binding (`node dist/index.js`):** Blocked locally because `npm install` could not install `fastify` in `backend/node_modules` on this host; covered by the `backend` job in `.github/workflows/ci.yml`.
2. **Docker Compose stack & container builds (`caddy`, `ollama`, `wyoming-whisper`, `wyoming-piper`, `neptune-backend`, `neptune-asterisk`):** Docker Engine is not available locally; builds are configured in the `docker-build` job in `.github/workflows/ci.yml`, while full multi-container runtime startup requires a Linux VM following [INSTALLATION.md](./INSTALLATION.md).
3. **Physical Voice Pipeline (`scripts/verify-phase3-voice.sh`, `scripts/benchmark-voice-phase3.py`) & Asterisk SIP Calls (`scripts/verify-phase7-telephony.sh`):** Require live Wyoming Whisper/Piper TCP servers, Asterisk 20 PJSIP daemon, `sox`, and SIP softphone/handset endpoints.
4. **Physical Smart Home & Entertainment (`scripts/verify-phase5-tv.sh`, live HAOS, LG webOS TV, Jellyfin NAS):** Require live LAN appliances, valid `HOMEASSISTANT_TOKEN`, and physical TV power/ARC states.
5. **Interactive Browser DOM Execution (`frontend/dist/index.html`):** HTML escaping and event delegation are statically verified in `TestRepositoryConfigAndSecurity.test_frontend_escapes_html_before_innerhtml`, but live browser push-to-talk audio recording and Caddy HTTPS certificate flows require a real browser connected to `https://neptune.home.arpa`.
