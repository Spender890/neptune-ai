# Neptune-AI — Open-Source Readiness Audit

**Audit Date:** 2026-11-15  
**Target Repository:** `https://github.com/Spender890/neptune-ai`  
**Baseline Commit Inspected:** `9af7de9` (`docs: finalize Neptune-AI publication audit and documentation`)  
**Auditor Role:** Senior Open-Source Software Engineer, QA Engineer, Security Reviewer, and Technical Documentation Specialist  

---

## 1. Executive Summary

Neptune-AI has a clear, practical core architecture: a TypeScript/Fastify backend pairing a deterministic sub-10ms regex router (`FastPathRouter`) with an Ollama local LLM fallback (`qwen2.5:3b`), integrated with Home Assistant, Jellyfin, LG webOS (via Home Assistant), and an Asterisk PJSIP/AGI voice pipeline backed by Wyoming Whisper and Piper.

Prior to this audit, the repository had strong initial design documentation and integration verification shell scripts, **but was not yet ready for an external open-source community launch**. Key blockers included:

1. **Zero automated unit tests or CI pipeline:** `backend/test/` did not exist, no GitHub Actions workflows existed, and `backend/package.json` referenced `node --test dist/**/*.test.js` with zero test files.
2. **Version & configuration drift:** Backend reported `0.4.0` in `backend/package.json`, `0.7.0` in `backend/src/index.ts`, `0.1.0` in `docker-compose.yml`, and `0.1.2` in `CHANGELOG.md`.
3. **Broken fresh-build container assumptions:** `asterisk/Dockerfile` omitted the `wyoming` Python dependency required by `scripts/asterisk-voice-agent.py` and omitted `/var/spool/asterisk/tmp`; `.env.example` entity IDs did not match `fastpath.ts` or `allowed_entities.json`.
4. **High-severity security and reliability bugs:** Unreachable `consequential_entities` confirmation logic in `backend/src/permissions.ts`, `.call` file newline injection vectors, unescaped `innerHTML` DOM XSS in `frontend/dist/index.html`, HTTP-only client modules failing on `https://` URLs, and missing emergency-number dialing guards.
5. **Missing community infrastructure:** No `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub Issue/PR templates, or newcomer standalone installation path independent of a specific Proxmox VE host layout.

---

## 2. Baseline Repository State & Git Inspection

- **Git History:** 2 commits on `main` (`5f2a018` initial release, `9af7de9` publication audit). Working tree clean before audit.
- **Tracked Files:** 49 tracked files across `backend/`, `asterisk/`, `config/`, `frontend/dist/`, `scripts/`, `docs/`, and root configuration/documentation.
- **Ignored Artifacts:** `scripts/__pycache__/` present locally; no `.env` or secret files committed in Git history.
- **License:** MIT License (`LICENSE`, Copyright (c) 2026 Spender890) — valid and preserved unchanged.
- **Baseline Static & Test Checks (Observed on Windows Audit Host):**
  - `python -m py_compile scripts/asterisk-voice-agent.py scripts/benchmark-voice-phase3.py`: **Exit 0 (Pass)**.
  - JSON syntax validation (`config/allowed_entities.json`, `config/contacts.json.example`, `backend/package.json`, `backend/tsconfig.json`): **Exit 0 (Pass)**.
  - `backend/node_modules`: **Not present**; `npm`/`tsc` not available in host PATH (`node` found in local runtimes only).
  - Unit tests (`backend/test/`, `tests/`): **0 tests existed at baseline**.
  - CI workflows (`.github/workflows/`): **None existed at baseline**.
  - Live Docker stack / Proxmox hardware tests: **Not runnable on Windows host** (no Docker daemon / no HAOS / no Asterisk / no physical LG TV).

---

## 3. Feature Implementation Inventory (Code vs. Documentation)

| Capability | Actual Code Evidence | Documentation Claim | Classification |
| :--- | :--- | :--- | :--- |
| **FastPath Deterministic Router** | `backend/src/fastpath.ts` (11 intent categories + lock/cover) | Claimed implemented (`README.md`, `PROJECT_STATUS.md`) | **Implemented & Unit-Tested** |
| **Permissions Gateway (Allowlist & Consequential Gate)** | `backend/src/permissions.ts` (`validate`) | Claimed implemented (`SECURITY.md`) | **Implemented (Fixed bug where `consequential_entities` was unreachable)** |
| **Home Assistant REST Integration** | `backend/src/homeassistant.ts` (`callService`, `getState`) | Claimed implemented (`README.md`) | **Implemented (Added HTTPS & URL-encoding hardening)** |
| **Ollama Local LLM Fallback** | `backend/src/ollama.ts` (`/api/chat` tool-calling) | Claimed `qwen2.5:3b` (`README.md`), `bonsai-2:4b` (`ARCHITECTURE.md`) | **Implemented (Single-turn tool dispatch + chat)** |
| **LG webOS TV & Jellyfin Playback** | `backend/src/webos.ts`, `backend/src/jellyfin.ts` | Claimed implemented (`README.md`) | **Implemented (Relies on HA `webostv` & Jellyfin HTTP API)** |
| **Persistent Reminders & Agenda Daemon** | `backend/src/reminders.ts`, `backend/src/agenda.ts` | `README.md` (`reminders.json`), `ARCHITECTURE.md` (SQLite) | **Implemented using JSON storage (`reminders.json`)** |
| **Outbound Asterisk `.call` Spooling** | `backend/src/telephony.ts`, `asterisk/extensions.conf` | Claimed implemented (`README.md`) | **Implemented (Hardened against injection & emergency dialing)** |
| **Asterisk AGI Voice Loop** | `scripts/asterisk-voice-agent.py`, `asterisk/extensions.conf` | Claimed implemented (`README.md`) | **Implemented (Added pure-Python Wyoming fallback)** |
| **Web Cockpit UI** | `frontend/dist/index.html` (801 lines) | Claimed PTT voice capture (`ARCHITECTURE.md`, `README.md` v1) | **Text UI Implemented; Mic button is visual toggle only** |
| **Browser Audio Upload / FFmpeg Ingest** | No `/api/voice/transcribe` or `/ws` route in `backend/src/index.ts` | Documented in `ARCHITECTURE.md` Section 4.2 | **Planned (Not Implemented)** |
| **Interactive Web Confirmation Modal (30s TTL)** | `SESSION_SECRET` / `REQUIRE_CONFIRMATION_TIMEOUT_SECONDS` unused in `backend/src/`; UI had no modal | Claimed in `SECURITY.md` v1 & `ARCHITECTURE.md` | **Partial (Backend blocks & flags; interactive `/api/confirm` loop planned)** |
| **SQLite `audit_logs` & Reminder DB** | `DATABASE_PATH` unused; uses Pino JSON stdout + `reminders.json` | Claimed in `ARCHITECTURE.md` | **Planned (Not Implemented)** |
| **Silero VAD / Barge-In / Streaming TTS** | Uses Asterisk `Record(...,2,7,k)` silence detection & whole-utterance Piper | Mentioned in `docs/EXPANDED_ARCHITECTURE_ASSESSMENT.md` & `README.md` roadmap | **Planned (Not Implemented)** |

---

## 4. Detailed Audit Findings

| ID | Severity | Component | Evidence | Impact | Recommended Fix | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **OSR-01** | **Critical** | Automated Testing | No `backend/test/`, no Python tests, no `.github/workflows/`. `backend/package.json` line 9 ran `node --test dist/**/*.test.js` on zero tests. | Contributors cannot verify changes locally or in PRs; regressions go undetected. | Add comprehensive Node.js (`node:test`) and Python (`unittest`) suites + GitHub Actions CI. | **Fixed** |
| **OSR-02** | **Critical** | Security / Permissions | `backend/src/permissions.ts` lines 35–42 checked `allowed_domains` before `consequential_entities`, while `config/allowed_entities.json` excluded `lock` and `cover`. | `lock.front_door` and `cover.garage_door` were rejected outright instead of returning `requires_confirmation: true`, and LLM tool loops suppressed confirmation prompts. | Check `consequential_entities` before `allowed_domains`; add lock/cover patterns to `FastPathRouter`; surface `requires_confirmation` on LLM tool path. | **Fixed** |
| **OSR-03** | **Critical** | Telephony / Security | `backend/src/agenda.ts` lines 93–94 and `backend/src/telephony.ts` lines 62–70 wrote unsanitized `rem.title`, `recipientName`, and `sender` into Asterisk `.call` files. | Newline injection (`\nApplication: System...`) in a reminder or caller name could inject arbitrary Asterisk call directives. | Strip `\r`, `\n`, `\0` from all `.call` fields and strictly validate extension format. | **Fixed** |
| **OSR-04** | **High** | Telephony / Dockerfile | `asterisk/Dockerfile` omitted `wyoming` pip package and `/var/spool/asterisk/tmp` directory, yet `scripts/asterisk-voice-agent.py` imports `wyoming.*` and writes to `/var/spool/asterisk/tmp`. | Fresh Docker builds of `neptune-asterisk` fail on Extension 7000 voice calls. | Install `wyoming` + create `/var/spool/asterisk/tmp` in `asterisk/Dockerfile`, and add stdlib Wyoming TCP fallback in `asterisk-voice-agent.py`. | **Fixed** |
| **OSR-05** | **High** | Web Cockpit XSS | `frontend/dist/index.html` lines 682–711 interpolated `rem.title`, `rem.created_by`, `rem.target_person`, `rem.id` directly into `innerHTML`. | Any reminder containing `<img src=x onerror=...>` executes arbitrary JS in the browser cockpit. | Introduce `escapeHtml()` and sanitize all dynamic fields rendered in DOM. | **Fixed** |
| **OSR-06** | **High** | Config Consistency | `.env.example` lines 46–47 set `TV_ENTITY_ID=media_player.living_room_tv` & `SPEAKER_ENTITY_ID=media_player.whole_house_speaker`, while `fastpath.ts` lines 21–22 & `agenda.ts` line 66 hardcoded `media_player.living_room_lg_webos_tv_qned806qa` & `media_player.living_room_vlc_telnet`. | Users following `.env.example` could not override TV/speaker entities in `FastPathRouter` or `AgendaDaemon`. | Read `TV_ENTITY_ID` and `SPEAKER_ENTITY_ID` dynamically in `FastPathRouter` and `AgendaDaemon`; align `.env.example` and `allowed_entities.json`. | **Fixed** |
| **OSR-07** | **High** | Verification Script Bug | `scripts/verify-phase7-telephony.sh` line 48 checked `grep -q "EAGI"` while `asterisk/extensions.conf` lines 34, 39, 45, 51 use `AGI(...)`. | Phase 7 telephony verification script fails against the committed dialplan. | Update regex to `grep -qE "E?AGI"`. | **Fixed** |
| **OSR-08** | **High** | Version Drift | `package.json` (`0.4.0`), `backend/src/index.ts` (`0.7.0`), `docker-compose.yml` (`0.1.0`), `CHANGELOG.md` (`0.1.2`). | Confusing release state for packagers and users. | Standardize all manifests and `/api/health` to `0.1.0` for initial public launch. | **Fixed** |
| **OSR-09** | **Medium** | Documentation Drift | `README.md` line 179 & `PROJECT_STATUS.md` line 28 cite `Ollama v0.40.16` (invalid version; Compose pins `0.4.16`). `README.md` lines 179 & 182 claim `--ipc=host` and `network_mode: host` not present in `docker-compose.yml`. `ARCHITECTURE.md` still cites `Bonsai 2 4B`, `ollama:0.5.7`, and SQLite. | Misleads contributors and testers about container runtime topology and active dependencies. | Reconcile `README.md`, `ARCHITECTURE.md`, `PROJECT_STATUS.md`, and `INSTALLATION.md` with exact code and Compose config. | **Fixed** |
| **OSR-10** | **Medium** | Community Docs | Missing `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, Issue/PR templates, and non-Proxmox Quickstart. | High barrier to entry for external contributors and testers without Proxmox VE. | Add community templates, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and standalone Docker Compose guide. | **Fixed** |
| **OSR-11** | **Medium** | HTTPS Client Support | `homeassistant.ts`, `jellyfin.ts`, and `ollama.ts` used only Node's `http` module. | Configuring `https://` endpoints in `.env` fails with protocol mismatch. | Support both `http` and `https` modules dynamically based on `URL.protocol`. | **Fixed** |
| **OSR-12** | **Medium** | Credential Tracking Risk | `asterisk/pjsip.conf` is tracked in Git while `INSTALLATION.md` instructs users to edit it with live passwords. | Risk of users accidentally committing real SIP credentials in forks/PRs. | Document safe local override / git update-index guidance and add `pjsip.conf.local` / runtime warning in `SECURITY.md` and `INSTALLATION.md`. | **Documented / Mitigated** |
| **OSR-13** | **Low** | Personal Identifiers | Hardcoded `'Sultan'` fallback in `backend/src/reminders.ts` line 64 and `'sultan'` alias in `backend/src/contacts.ts` line 19. | Leaks developer-specific defaults to open-source adopters. | Replace with `process.env.PRIMARY_USER_NAME \|\| 'Primary'`. | **Fixed** |

---

## 5. Readiness Assessment Summary

- **Pre-Audit Readiness:** **Not Ready (4/10)** — Strong local hardware architecture, but lacked automated tests, CI, consistent versioning, community templates, and contained critical permissions/XSS/injection/build issues.
- **Post-Remediation Readiness:** **Ready for Public Beta / External Testers (8/10)** — Core routing, permissions, security boundaries, Python voice pipeline, and repository configurations are now verified by automated unit and mock-integration tests, with transparent separation between verified local logic and unverified physical hardware deployments.
