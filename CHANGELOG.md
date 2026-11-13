# Changelog

All notable changes to Project Neptune-AI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]
### Planned
- Phase 2: Ollama and Bonsai 2 4B model deployment and tool-calling validation.
- Phase 3: Wyoming Whisper and Piper neural speech microservices.
- Phase 4: Neptune Fastify/TypeScript core backend and security gateway.
- Phase 5: Home Assistant and Music Assistant / Jellyfin connectors.
- Phase 6: Responsive Cockpit UI and Web Audio Push-to-Talk streaming.
- Phase 7: End-to-end multi-device testing and performance tuning.

---

## [0.1.2] - 2026-11-10
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
