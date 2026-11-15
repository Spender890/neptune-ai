# Neptune-AI — Technical Debt Register

**Audit Date:** 2026-11-15  
**Scope:** Full source tree (`backend/src/`, `scripts/`, `asterisk/`, `frontend/dist/`, `docker-compose.yml`, `.env.example`, `config/`)

---

## Summary Table

| ID | Severity | Component | Summary | Status |
| :--- | :--- | :--- | :--- | :--- |
| **TD-01** | High | Backend HTTP Clients | `homeassistant.ts`, `jellyfin.ts`, `ollama.ts` imported only `http`, failing on `https://` URLs | **Resolved** |
| **TD-02** | High | Entity Configuration | `fastpath.ts` and `agenda.ts` hardcoded entity IDs instead of reading `.env` (`TV_ENTITY_ID`, `SPEAKER_ENTITY_ID`) | **Resolved** |
| **TD-03** | High | Asterisk Container | `asterisk/Dockerfile` lacked `wyoming` Python package & `/var/spool/asterisk/tmp` directory | **Resolved** |
| **TD-04** | Medium | Telephony Test Script | `scripts/verify-phase7-telephony.sh` checked `EAGI` instead of `AGI` | **Resolved** |
| **TD-05** | Medium | Backend Coupling & Module Safety | `backend/src/index.ts` started HTTP server unconditionally on import; bare `__dirname` broke ESM execution | **Resolved** |
| **TD-06** | Medium | Persistence & Daemon Concurrency | Non-atomic `reminders.json` write in `reminders.ts`; missing re-entrancy guard in `agenda.ts` | **Resolved** |
| **TD-07** | Medium | Compose Env Wiring & Healthcheck | `docker-compose.yml` ignored `.env` Whisper/Piper vars and lacked `asterisk` healthcheck | **Resolved** |
| **TD-08** | Low | Hardcoded Developer Defaults | `'Sultan'` hardcoded in `reminders.ts` and `contacts.ts`; unused vars in `.env.example` | **Resolved / Documented** |
| **TD-09** | Medium | Dependency Lockfile & Linting | No `backend/package-lock.json` committed; no ESLint/Prettier config or typecheck script | **Partially Resolved (scripts added; lockfile requires `npm install` on Node toolchain)** |
| **TD-10** | Medium | Telephony Concurrency | `asterisk/extensions.conf` & `asterisk-voice-agent.py` share static `/var/spool/asterisk/tmp/*.wav` filenames | **Open (Documented for v0.2.0)** |
| **TD-11** | Low | Frontend Architecture | `frontend/dist/index.html` is a single 801-line static HTML file without source build step or Web Audio capture | **Open (Documented)** |

---

## Detailed Technical Debt Items

### TD-01 (High): HTTP-Only Upstream Clients
- **Evidence:** `backend/src/homeassistant.ts:1`, `backend/src/jellyfin.ts:1`, `backend/src/ollama.ts:1` only imported `node:http`, yet calculated `port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80)`. Passing an `https://` URL to `http.request()` fails because Node's `http` module rejects `https:` protocol URLs.
- **Impact:** Users running Home Assistant or Jellyfin behind TLS cannot connect.
- **Recommended Fix:** Select `https.request` when `urlObj.protocol === 'https:'` and `http.request` otherwise.
- **Status:** Fixed in `homeassistant.ts`, `jellyfin.ts`, and `ollama.ts`.

### TD-02 (High): Hardcoded Entity IDs Bypassing `.env`
- **Evidence:** `backend/src/fastpath.ts:21-22` hardcoded `'media_player.living_room_lg_webos_tv_qned806qa'` and `'media_player.living_room_vlc_telnet'`, and `backend/src/agenda.ts:66` hardcoded `'media_player.living_room_vlc_telnet'`. Meanwhile `.env.example:46-47` defined `TV_ENTITY_ID=media_player.living_room_tv` and `SPEAKER_ENTITY_ID=media_player.whole_house_speaker`.
- **Impact:** Anyone deploying Neptune-AI with their own Home Assistant entity names could not change FastPath or Reminder Speaker targets via `.env`.
- **Recommended Fix:** Pass `TV_ENTITY_ID` and `SPEAKER_ENTITY_ID` from environment into `FastPathRouter` and `AgendaDaemon`, and align `.env.example` and `config/allowed_entities.json`.
- **Status:** Fixed.

### TD-03 (High): Missing `wyoming` Dependency and Spool Temp Dir in `asterisk/Dockerfile`
- **Evidence:** `scripts/asterisk-voice-agent.py:18-21` imported `wyoming.client`, `wyoming.tts`, `wyoming.asr`, and `wyoming.audio`, and wrote audio files under `/var/spool/asterisk/tmp/`. `asterisk/Dockerfile:3-15` installed `py3-pip` but never installed `wyoming` or created `/var/spool/asterisk/tmp`.
- **Impact:** Rebuilding `neptune-asterisk` from scratch would raise `ModuleNotFoundError: No module named 'wyoming'` or `FileNotFoundError` when dialing Extension `7000`.
- **Recommended Fix:** Install `wyoming` and create `/var/spool/asterisk/tmp` in `asterisk/Dockerfile`, plus add a pure-Python Wyoming TCP socket fallback in `scripts/asterisk-voice-agent.py`.
- **Status:** Fixed.

### TD-04 (Medium): `verify-phase7-telephony.sh` Assertion Mismatch
- **Evidence:** `scripts/verify-phase7-telephony.sh:48` checked `grep -q "EAGI"`, whereas `asterisk/extensions.conf:34,39,45,51` use `AGI(asterisk-voice-agent.py)`.
- **Impact:** Running `scripts/verify-phase7-telephony.sh` exits with failure code 1 even on a healthy deployment.
- **Recommended Fix:** Match `grep -qE "E?AGI"`.
- **Status:** Fixed.

### TD-05 (Medium): Unconditional Server Startup & `__dirname` Fragility
- **Evidence:** `backend/src/index.ts:519` called `start()` unconditionally on module evaluation, and `contacts.ts:38`, `reminders.ts:29`, and `index.ts:24` relied on CommonJS-only `__dirname`.
- **Impact:** Prevented importing backend modules in automated unit tests without binding TCP port 3000 or crashing under ESM/Node native TypeScript stripping.
- **Recommended Fix:** Extract `NeptuneEngine` (testable core router/API logic independent of Fastify listen loop), guard `start()` behind `require.main === module`, and use safe `typeof __dirname !== 'undefined'` path resolution.
- **Status:** Fixed.

### TD-06 (Medium): Non-Atomic File Persistence & Daemon Re-entrancy
- **Evidence:** `backend/src/reminders.ts:52` wrote directly via `fs.writeFileSync(this.filePath, ...)`; `backend/src/agenda.ts:25` triggered `this.tick()` every 3s without guarding overlapping executions.
- **Impact:** A crash mid-write could truncate `reminders.json`; slow Home Assistant timeouts (>3s) could overlap timer ticks.
- **Recommended Fix:** Write to `${filePath}.tmp` and `fs.renameSync` atomically; add `isTicking` re-entrancy guard in `AgendaDaemon.tick()`.
- **Status:** Fixed.

### TD-07 (Medium): Unwired Compose Environment Variables & Missing Asterisk Healthcheck
- **Evidence:** `docker-compose.yml:88` hardcoded `--model base.en --language en`, line 108 hardcoded `--voice en_US-lessac-medium`, and `asterisk` (lines 154–176) had no `healthcheck`.
- **Impact:** Changing `WHISPER_MODEL`, `WHISPER_LANGUAGE`, or `PIPER_VOICE` in `.env` had no effect on containers.
- **Recommended Fix:** Wire `${WHISPER_MODEL:-base.en}`, `${WHISPER_LANGUAGE:-en}`, and `${PIPER_VOICE:-en_US-lessac-medium}` in `docker-compose.yml`, and add an Asterisk healthcheck.
- **Status:** Fixed.

### TD-08 (Low): Hardcoded Developer Name & Unused `.env.example` Keys
- **Evidence:** `backend/src/reminders.ts:64` defaulted `target_person` to `'Sultan'`; `backend/src/contacts.ts:19` included `'sultan'` in default aliases; `.env.example:69,71,72` declared `DATABASE_PATH`, `SESSION_SECRET`, and `REQUIRE_CONFIRMATION_TIMEOUT_SECONDS` which were unused in `backend/src/`.
- **Impact:** Confuses community users who expect `.env` flags to be active or do not expect author-specific names in fallback defaults.
- **Recommended Fix:** Default to `PRIMARY_USER_NAME || 'Primary'` in code, and explicitly mark reserved/planned `.env.example` keys as such.
- **Status:** Fixed.

### TD-09 (Medium): Missing `package-lock.json` & Host Toolchain
- **Evidence:** `backend/` previously contained `package.json` (`fastify: ^4.26.2`, `typescript: ^5.3.3`) with caret ranges and no `package-lock.json`; `backend/Dockerfile:11,24` used `npm install` instead of `npm ci`.
- **Impact:** Non-deterministic dependency resolution across fresh Docker builds if a transitive dependency publishes a breaking or vulnerable minor release.
- **Recommended Fix:** Generate and commit `backend/package-lock.json` on a machine with Node/npm (or in CI) and switch `backend/Dockerfile` to `npm ci` once a lockfile is present.
- **Status:** Fixed (`backend/package-lock.json` generated and verified with `fastify@^5.2.1` with 0 audit vulnerabilities; `backend/Dockerfile` updated to `npm ci`).

### TD-10 (Medium): Shared Temp Audio Paths in Concurrent Asterisk Calls
- **Evidence:** `asterisk/extensions.conf:49` records to `/var/spool/asterisk/tmp/user_turn:wav` and `scripts/asterisk-voice-agent.py:51,163,180,193,201,212,219,230` write fixed filenames in `/var/spool/asterisk/tmp/`.
- **Impact:** If two SIP extensions call `7000` simultaneously, audio files can overwrite each other.
- **Recommended Fix:** Parameterize temp filenames by `${UNIQUEID}` from Asterisk AGI `agi_uniqueid` and clean up per-call temp files on hangup.
- **Status:** Open (documented as known limitation for single-household concurrency in v0.1.0).

### TD-11 (Low): Single-File Frontend Without Automated Push-to-Talk Audio Upload
- **Evidence:** `frontend/dist/index.html` is hand-authored static HTML/JS; lines 787–792 toggle a CSS `.recording` state without calling `navigator.mediaDevices.getUserMedia` or uploading audio to the backend.
- **Impact:** Web UI supports text commands, TV controls, intercom triggers, and reminders, while browser microphone capture remains unimplemented (real voice works via SIP Ext `7000`).
- **Recommended Fix:** Keep clearly labeled as text/cockpit UI in docs; implement Web Audio upload endpoint (`/api/voice/transcribe`) and frontend recorder in v0.2.0.
- **Status:** Open (accurately documented in `README.md` and `OPEN_SOURCE_READINESS_AUDIT.md`).
