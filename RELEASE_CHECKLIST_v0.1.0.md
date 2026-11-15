# Neptune-AI `v0.1.0` Release Checklist & Draft Release Notes

> [!IMPORTANT]
> **Do NOT run `git push`, `git tag`, or publish a GitHub release automatically.** This checklist prepares all artifacts locally so maintainers can review, run live Linux/Docker verification, and decide when to tag `v0.1.0`.

---

## 1. Pre-Release Gate Checklist

| Category | Requirement | Status | Notes |
| :--- | :--- | :--- | :--- |
| **Version Consistency** | Unified `0.1.0` across `backend/package.json`, `backend/src/engine.ts` (`/api/health`), `docker-compose.yml`, and `CHANGELOG.md` | **Pass** | Verified automatically in `test_package_versions_consistent_at_0_1_0` |
| **License** | MIT `LICENSE` preserved intact (`Copyright (c) 2026 Spender890`) | **Pass** | Verified unchanged |
| **Secrets & `.env.example`** | Zero real tokens/passwords in Git history or tracked templates; complete `.env.example` placeholders | **Pass** | Verified in `SECURITY_REVIEW.md` & `test_no_real_secrets_in_tracked_templates` |
| **Core Security Hardening** | `consequential_entities` ordering, `.call` sanitization, emergency dialing block, Web UI `escapeHtml()`, optional `NEPTUNE_API_KEY` | **Pass** | Verified by Node & Python test suites |
| **Automated Unit & Mock Tests** | Backend Node (`17` tests / `8` suites) & Python (`13` tests) green after final edits | **Pass** | Executed locally on Windows audit host |
| **CI Pipeline** | `.github/workflows/ci.yml` configured (`backend`, `python-and-shell`, `docker-build`) | **Ready** | Triggers on `push` / `pull_request` to `main` after repository push |
| **Documentation & Templates** | `README.md`, `INSTALLATION.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, Issue/PR templates, audit reports | **Pass** | Reconciled with `v0.1.0` codebase; planned `v0.2.0` features labeled explicitly |
| **Known Open Technical Debt** | Documented transparently (`TD-10` single-turn Asterisk spool filename, `TD-11` PTT browser upload stub) | **Documented** | See `TECHNICAL_DEBT.md` & `RELEASE_CHECKLIST` Known Limitations |
| **Maintainer Action Before Tagging** | 1. Push topic branch and confirm green GitHub Actions CI run (`backend`, `python-and-shell`, `docker-build`)<br>2. Smoke-test `docker compose up -d --build` on Linux/Docker host | **Pending Maintainer** | Windows audit workstation verified Node/TypeScript/Python; live Docker daemon requires Linux host |

---

## 2. Draft GitHub Release Notes (`v0.1.0`)

```markdown
# Neptune-AI v0.1.0 — Public Community Beta

Neptune-AI is a 100% local, privacy-first home automation, entertainment, reminder, and SIP telephone AI assistant orchestrating **Home Assistant**, **Jellyfin**, **Ollama (`qwen2.5:3b`)**, **Wyoming Whisper/Piper**, **Asterisk 20**, and **Caddy**.

## Highlights
- **Deterministic Sub-Millisecond FastPath (`FastPathRouter`):** Handles lights, switches, climate, TV control, timers/reminders, outbound SIP calls, and security-sensitive locks/covers *before* invoking CPU-bound LLM inference.
- **Safety & Permissions Gateway (`PermissionsGateway`):** Strict regex entity/domain allowlisting with mandatory confirmation blocking (`requires_confirmation: true`) on `consequential_entities` (`lock.*`, `cover.*`) and blocked dialing of emergency/unmapped external phone numbers.
- **Asterisk PJSIP & Wyoming Voice Pipeline:** Full inbound Extension `7000` interactive voice assistant and outbound reminder calling with `sox` resampling and unified `StdlibWyomingClient` TCP transport.
- **Security Hardening:** Sanitized Asterisk `.call` spool generation, escaped Web Cockpit DOM rendering (`escapeHtml`), HTTPS upstream client support, atomic `reminders.json` persistence, and optional `NEPTUNE_API_KEY` header authentication.
- **CI & Automated Test Suite:** Added `backend/test/neptune.test.ts` (`17` unit/mock tests), `tests/test_neptune_python.py` (`13` voice/repo security tests), `scripts/benchmark-fastpath.ts`, and `.github/workflows/ci.yml`.
- **Complete Open-Source Docs:** Standalone Linux Docker Compose & Proxmox VE guides (`INSTALLATION.md`), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, Issue/PR templates, and audit reports.

## Known Limitations in `v0.1.0`
- **Web Cockpit Push-to-Talk:** The dashboard text command bar and reminder manager are functional, while live browser microphone capture (`/api/voice/transcribe`) is planned for `v0.2.0` (live voice works via SIP telephony Extension `7000`).
- **Two-Step Confirmation Endpoint:** `consequential_entities` actions are safely blocked and flagged (`requires_confirmation: true`), pending the interactive `/api/confirm` approval flow in `v0.2.0`.
- **Concurrency & Persistence:** Concurrent calls to Extension `7000` share a static `/var/spool/asterisk/tmp` audio path; reminders persist atomically to `data/reminders.json` (optional SQLite audit log planned for `v0.2.0`).
- **Node Lockfile:** `backend/package-lock.json` is generated and pinned to `fastify@^5.2.1` with 0 audit vulnerabilities; `backend/Dockerfile` uses `npm ci`.

## Upgrade / Fresh Install Notes
See [INSTALLATION.md](./INSTALLATION.md) for Standalone Docker Compose and Proxmox VE instructions, including the first-run `ollama pull qwen2.5:3b` step and `git update-index --skip-worktree asterisk/pjsip.conf` credential protection.
```
