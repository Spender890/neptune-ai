# Changelog

All notable changes to Project Neptune-AI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]
### Planned (`v0.2.0`)
- Interactive Web Confirmation Modal + `/api/confirm` endpoint for `consequential_entities` (`lock`, `cover`).
- Live Browser Push-to-Talk Web Audio streaming via `/api/voice` to Wyoming Whisper and Piper.
- Optional SQLite persistent audit log and ESLint/Prettier CI formatting enforcement.

---

## [0.1.0] - 2026-11-15 (Community Launch Candidate)
### Added
- **Automated Testing:** Zero-dependency TypeScript suite (`backend/test/neptune.test.ts` — 17 tests across 8 suites) and Python suite (`tests/test_neptune_python.py` — 13 tests) using deterministic mocks and in-memory transport doubles.
- **GitHub Actions CI (`.github/workflows/ci.yml`):** Automated TypeScript lint/build/test/audit, Python byte-compile/`unittest`, shell syntax checks, and Docker image builds (`neptune-backend`, `neptune-asterisk`).
- **Reproducible FastPath Microbenchmark:** Added `scripts/benchmark-fastpath.ts` with raw timing percentiles and explicit scope disclosures.
- **Open-Source Community & Audit Suite:** Added `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub issue/PR templates, `RELEASE_CHECKLIST_v0.1.0.md`, `OPEN_SOURCE_READINESS_AUDIT.md`, `TECHNICAL_DEBT.md`, `SECURITY_REVIEW.md`, and `TEST_COVERAGE_REPORT.md`.

### Fixed & Hardened
- **Security (`PermissionsGateway`):** Evaluated `consequential_entities` before `allowed_domains`, enforced strict entity regexes, and removed implicit `startsWith()` prefix bypasses.
- **Security (`FastPathRouter` & `NeptuneEngine`):** Deterministically matched lock/cover actions (`requires_confirmation: true`), propagated confirmation flags across LLM tool calls, added 500/1000-character bounds, and added optional `NEPTUNE_API_KEY` authentication (`X-API-Key` / `Authorization: Bearer`).
- **Security (`AgendaDaemon` & `TelephonyManager`):** Sanitized Asterisk `.call` fields against newline/quote/NUL injection, blocked emergency/unmapped external phone dialing, and guarded against concurrent `tick()` re-entrancy.
- **Security (`frontend/dist/index.html`):** Added `escapeHtml()` before `innerHTML` rendering and delegated reminder deletion click handlers to eliminate stored DOM XSS.
- **Reliability (`httpClient.ts`, `asterisk/Dockerfile`, `asterisk-voice-agent.py`):** Unified HTTP/HTTPS client with strict timeouts, atomic `.tmp` + `renameSync` reminder persistence, word-boundary `is_hangup_intent`, `wyoming==1.5.4` & unified `StdlibWyomingClient` TCP transport, and `.env.example` / `docker-compose.yml` alignment.

---

## Historical Pre-Launch Iterations (`2026-11-10` — consolidated into `v0.1.0`)

### 2026-11-10 (Pre-launch Milestone C)
### Changed
- Pinned Node.js backend container image to `node:20.18.1-alpine` (Active LTS).
- Corrected Caddy certificate documentation to state coverage is strictly for `neptune.home.arpa` and removed direct-IP HTTPS claims.
- Re-framed 3.0 GB HAOS + 8.0 GB Debian memory sizing as a baseline starting configuration subject to active monitoring.
- Documented complete-recording Push-to-Talk audio ingestion pipeline with FFmpeg resampling to 16 kHz mono PCM.
- Delineated static file validation from pending live container builds and explained Windows npm check exit code 1.
- Updated `INSTALLATION.md` to explicitly group commands by environment (Proxmox host vs Debian VM) with verification and rollback steps for each.

---

## [0.1.1] - 2026-11-10
### Changed
- Standardized all project references, paths, Docker containers, volumes, networks, and configuration to **Neptune-AI** (`neptune-*`).
- Re-architected Proxmox memory allocation: reduced HAOS to 3.0 GB and Debian AI VM to 8.0 GB.
- Converted `scripts/host-tuning.sh` into a strictly read-only, non-destructive audit script that outputs manual commands for owner review.
- Added working baseline stubs for `backend/` and `frontend/dist/`.
- Updated `scripts/setup-debian-vm.sh` with safe SSH port detection, non-root user permissions, and user assignment to the `docker` group.

---

## [0.1.0] - 2026-11-10
### Added
- Initial project architecture and specifications.
- Phase 1 Docker Compose orchestration and Caddy TLS proxy.
- Core documentation suite and test verification scripts.
