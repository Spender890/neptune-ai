# NEPTUNE-AI: Self-Hosted Local AI Home Assistant
## Architectural Blueprint & System Design Specification

*Document Version:* 1.4.0 (Reconciled with `v0.1.0` Codebase)  
*Status:* Reference Architecture (`v0.1.0` implemented core + `v0.2.0` planned extensions labeled explicitly)  
*Lead Architect:* Sultan (`Spender890`) & Contributors  

> [!NOTE]
> This document preserves the original Phase 1 dual-VM Proxmox VE blueprint while explicitly marking components modified during implementation (`qwen2.5:3b`, `reminders.json`, Asterisk PJSIP/AGI voice pipeline) vs. **Planned (`v0.2.0`)** items (`/api/voice/transcribe` browser mic upload, `/api/confirm` interactive modal, SQLite audit DB).

---

## 1. Executive Summary & Core Constraints

**Neptune-AI** is an autonomous, private, self-hosted personal AI assistant engineered to run entirely on local home infrastructure. It eliminates cloud speech-to-text, cloud natural language processing, and third-party data tracking.

### Core Architectural Boundaries
* **Strict VM Architecture:**
  * **VM 100:** Home Assistant OS (HAOS) for device integration, automations, and Music Assistant hub.
  * **VM 101:** Debian 12 running Neptune-AI services through Docker Compose.
  * **WD Sentinel DX4000:** Existing standalone server running Debian 12 and Jellyfin remains an independent, completely untouched external system on the local network (`192.168.1.60`). No changes to its OS or storage.
* **Browser Cockpit & SIP Telephony Channels:** Users access text command control, reminders, and entertainment status through the Web Cockpit (`https://neptune.home.arpa`), and live bidirectional two-way voice interactions via Asterisk PJSIP telephone extensions (`1001`, `1002`, `7000`). Browser Push-to-Talk audio capture (`navigator.mediaDevices.getUserMedia` -> `/api/voice/transcribe`) is designed in Section 4 and **Planned (`v0.2.0`)**.
* **Zero-Trust Security Boundary:** The local language model is treated as an untrusted reasoning engine with zero direct shell access, strict entity allowlists, and mandatory human confirmation for sensitive physical actions.

---

## 2. Hardware Resource Allocation & Memory Architecture

### 2.1. Physical Sizing Baseline: 16.0 GB Host RAM
The compute host is an Intel Core i7-10700 (8 physical cores / 16 threads, AVX2 support) with **16.0 GB DDR4 RAM** and no discrete GPU.

```
========================================================================================
                          PHYSICAL PROXMOX VE HOST (16.0 GB RAM)
          Initial Host Unallocated Margin: ~5.0 GB (Subject to Active Monitoring)
                     ZFS Adaptive Replacement Cache (ARC) Cap: 1.0 GB (Optional)
========================================================================================
             |                                                  |
             v                                                  v
+-----------------------------------+          +-----------------------------------+
|  VM 100: Home Assistant OS        |          |  VM 101: Debian 12 (Neptune AI)   |
|  - vCPU: 2 Cores (Type: host)     |          |  - vCPU: 6 Cores (Type: host)     |
|  - RAM: 3.0 GB (Fixed, no balloon)|          |  - RAM: 8.0 GB (Fixed, no balloon)|
|  - Disk: 32 GB (VirtIO SCSI)      |          |  - Disk: 64 GB (VirtIO SCSI)      |
|  - Workloads:                     |          |  - Workloads:                     |
|    * HA Core & Automations        |          |    * Caddy (Internal TLS Proxy)   |
|    * Device Integrations          |          |    * Neptune Backend (Node/TS)    |
|    * Music Assistant Add-on       |          |    * Ollama (Bonsai 2 4B)         |
+-----------------------------------+          |    * Wyoming-Whisper (STT)        |
                                               |    * Wyoming-Piper (TTS)          |
                                               |    * SQLite Database              |
                                               +-----------------------------------+
                                                                 |
                                                                 | Gigabit LAN (192.168.1.x)
                                                                 v
                                               +-----------------------------------+
                                               | Existing Server: WD Sentinel      |
                                               | - Debian 12 (Untouched)           |
                                               | - Jellyfin Media Server           |
                                               +-----------------------------------+
```

### 2.2. Memory Concepts: Allocated VM RAM vs. Host Available RAM vs. ZFS ARC

Understanding the interaction between these three tiers is critical to system stability:

1. **Allocated VM RAM (Committed Guest Memory):**
   * Memory dedicated by Proxmox KVM hypervisor to guest VMs: **3.0 GB (HAOS)** + **8.0 GB (Debian AI)** = **11.0 GB Total Committed**.
   * Memory ballooning is explicitly **disabled** to avoid dynamic memory shifts and CPU overhead.
2. **Host Available RAM (Initial Operating Margin):**
   * Physical RAM left uncommitted on the Proxmox host: $16.0\text{ GB} - 11.0\text{ GB} = \mathbf{5.0\text{ GB}}$ (**31.25%**).
   * **Active Monitoring Requirement:** This 5.0 GB margin is a **starting baseline configuration**, not an absolute guarantee against memory pressure. In production, host memory utilization depends dynamically on Proxmox hypervisor processes (`pvedaemon`, `pve-cluster`, `corosync`), backup snapshot RAM buffers, page caching, and ZFS ARC growth. System memory must be monitored under actual operational loads.
3. **ZFS Adaptive Replacement Cache (ARC):**
   * If Proxmox is installed on ZFS, ZFS manages its cache dynamically in kernel RAM. By default, Linux ZFS ARC can expand to **50% of physical host memory (~8.0 GB)**.
   * *The Eviction Lag Risk:* While ARC is dynamically shrinkable, sudden large memory allocations by virtual machines or backup tasks can outpace the kernel’s ARC eviction rate. Under heavy disk I/O, this latency can trigger host memory pressure.
   * *Neptune Policy:* Neptune-AI **never automatically modifies host storage or ARC settings**. Capping ARC to 1.0 GB is an informational option for the project owner to review. If Proxmox runs on `LVM-thin` or `ext4`, no ARC cap is needed.

### 2.3. Debian 12 AI VM Estimated Memory Budget (8.0 GB Allocation)

| Component | Resident Memory Target (RSS) | Peak Memory Target | Notes |
| :--- | :--- | :--- | :--- |
| **Debian 12 Base OS & Systemd** | 280 MB | 400 MB | Minimal headless server install |
| **Ollama Runtime & Bonsai 2 4B** | 1,800 MB | 2,600 MB | Ternary weights (~1.6GB) + 4k token KV cache |
| **Wyoming-Whisper (faster-whisper)** | 550 MB | 750 MB | `base.en` INT8 CTranslate2 engine |
| **Wyoming-Piper** | 120 MB | 200 MB | ONNX runtime, single-thread speech synthesis |
| **Neptune Backend (Fastify/TS)** | 100 MB | 200 MB | HTTP + WebSocket engine + SQLite driver |
| **Caddy Reverse Proxy & Static UI** | 35 MB | 70 MB | TLS termination, static asset compression |
| **OS Page Cache & Buffer Headroom** | 1,200 MB | 3,780 MB | Free buffer inside VM to prevent swap thrashing |
| **Total Estimated Footprint** | **~3,885 MB** | **~8,000 MB** | **Starting baseline allocation; to be monitored under load** |

---

## 3. Network Architecture & Local DNS (`neptune.home.arpa`)

### 3.1. Standardized Domain: RFC 8375 (`.home.arpa`)
The project standardizes on **`neptune.home.arpa`** as the primary local hostname:
* **Why not `.local`?** `.local` is reserved for Multicast DNS (mDNS / RFC 6762). While iOS and macOS handle mDNS natively, Android implementations frequently ignore mDNS for web browsing or fail across router VLANs.
* **Why `.home.arpa`?** RFC 8375 formally establishes `.home.arpa` as the designated non-unique domain for local home networks using standard unicast DNS.
* **Router Configuration:** On your TP-Link Omada Controller, a static **Local DNS Record** maps `neptune.home.arpa` directly to the Debian VM's static IP (`192.168.1.51`). This ensures fast, reliable name resolution across Android, iOS, Windows, Mac, and Smart TV browsers.

### 3.2. Caddy Internal CA & Certificate Coverage
* **Specific Name Coverage:** In [`Caddyfile`](./Caddyfile), Caddy's internal Certificate Authority generates a certificate issued **specifically for `neptune.home.arpa`**.
* **No Direct-IP HTTPS:** The internal certificate does **not** cover raw IP addresses (e.g. `192.168.1.51`). Accessing the assistant via direct IP (`https://192.168.1.51`) will produce a browser SSL domain mismatch error (`NET::ERR_CERT_COMMON_NAME_INVALID`). All client devices must access the system via the configured domain: **`https://neptune.home.arpa`**.
* **Root CA Trust:** Client devices trust Caddy's root certificate (`root.crt`) once. Mobile browsers immediately recognize the connection as a trusted Secure Context, unlocking `navigator.mediaDevices.getUserMedia` without browser warnings.

---

## 4. Voice Subsystem & Audio Transcoding Pipeline

### 4.1. Implemented Telephony Voice Pipeline (`v0.1.0`)
In `v0.1.0`, live voice capture and speech synthesis run end-to-end over **Asterisk PJSIP + Python AGI (`scripts/asterisk-voice-agent.py`)**:
* Asterisk records caller turns (`/var/spool/asterisk/tmp/user_turn.wav`), `sox` resamples to 16kHz mono PCM, `StdlibWyomingClient` / `wyoming` streams PCM to `wyoming-whisper` (`10300`), text routes to `FastPathRouter` / Ollama (`qwen2.5:3b`), and `wyoming-piper` (`10200`) synthesizes 22.05kHz PCM resampled via `sox` to 8kHz mono WAV for Asterisk `STREAM FILE`.

### 4.2. Browser Audio Compatibility & Planned Complete-Recording Ingest (`v0.2.0` Design)
Web browsers record in differing, non-uniform audio formats:
* **iOS Safari (WebKit):** Typically emits `audio/mp4` (AAC container) or `audio/webm;codecs=opus`.
* **Android Chrome / Desktop (Chromium):** Emits `audio/webm;codecs=opus`.
* **Raw Web Audio API:** Emits uncompressed WAV (`audio/wav`) at 44.1 kHz or 48 kHz stereo.
* **Whisper STT Requirement:** Wyoming-Whisper strictly requires **16,000 Hz, 16-bit, single-channel (mono) raw PCM audio**.

For future browser push-to-talk (`v0.2.0`), Neptune-AI avoids brittle chunked streaming and targets a **complete-recording ingestion pipeline** (`/api/voice/transcribe` — *planned, not yet implemented in `backend/src/index.ts`*):

```
[ User Holds PTT Button ]
       |
       +---> Browser MediaRecorder records audio into local client memory
       |
[ User Releases PTT Button ]
       |
       +---> MediaRecorder emits complete audio Blob
       +---> Complete audio payload uploaded to Neptune Backend (/api/voice/transcribe or /ws)
       |
       v
[ Neptune Backend Audio Ingest ]
       |
       +---> 1. Format Detection: Inspects MIME header & magic bytes (EBML, RIFF, ftyp)
       |
       +---> 2. Server-side FFmpeg Conversion:
       |        Transcodes complete audio buffer directly into memory:
       |        ffmpeg -i pipe:0 -f s16le -acodec pcm_s16le -ac 1 -ar 16000 pipe:1
       |
       v
[ 16,000 Hz 16-bit Mono PCM Buffer ]
       |
       v
[ Forwarded to Wyoming-Whisper STT Socket (Port 10300) ]
```

> [!IMPORTANT]
> **Compatibility Verification Status:** While this pipeline is architecturally designed to support Android Chrome, iOS Safari, and Desktop Chrome, **cross-device audio compatibility cannot be claimed as verified until physically tested on actual devices in Phase 6**.

---

## 5. AI Reasoning & Bonsai 2 4B Evaluation

### Delineation of Facts, Assumptions and Estimates

| Dimension | Classification | Technical Analysis |
| :--- | :--- | :--- |
| **Model Registry & Origin** | **Verified Fact** | `bonsai-2:4b` is an official model in the Ollama library (`ollama run bonsai-2:4b`), developed by Prism ML based on Qwen3.5 with ternary quantization ($\{-1, 0, +1\}$). Download size: ~1.6 GB. |
| **Ollama Tool Support** | **Verified Fact** | Ollama's API officially supports structured tool calling schemas for models with tool metadata. |
| **Complex Schema Reliability** | **Unverified Assumption** | Extreme weight compression (ternary quantization) historically risks degradation in strict JSON syntax adherence under complex multi-parameter schemas. **This remains an unverified assumption until Phase 2 benchmarking.** |
| **CPU Generation Latency** | **Benchmark Target** | Target: $\ge 15$ tokens/sec on an Intel Core i7-10700 using AVX2. *(Untested on physical hardware)*. |
| **Memory Footprint** | **Design Target** | Target: $\le 2.6$ GB RAM inside Ollama under a 4,096-token context window. *(Untested on physical hardware)*. |

### Fallback Contingency
If Phase 2 acceptance testing reveals tool-calling failures or schema deviations:
* **Immediate Drop-in Fallback:** `qwen2.5:3b-instruct-q4_K_M` (proven 4-bit quantized model with industry-leading tool-calling accuracy for its size, ~2.2 GB RAM). Swapped via a single configuration variable in `.env`: `LLM_MODEL=qwen2.5:3b-instruct-q4_K_M`.

---

## 6. Performance Benchmark Targets (Design Goals)

All figures below represent **hypothesized design targets**, not verified measurements. Physical latency and throughput will be formally benchmarked on your Intel Core i7-10700 in Phase 2 and Phase 3:

| Metric | Target Specification | Phase to Benchmark | Notes |
| :--- | :--- | :--- | :--- |
| **Whisper STT Turnaround** | $\le 450$ ms | Phase 3 | 3-second utterance on CPU (base.en INT8) |
| **Piper TTS Turnaround** | $\le 200$ ms | Phase 3 | 15-word sentence synthesis on CPU |
| **Fast-Path Home Command TTFA** | $\le 600$ ms | Phase 4 | End-to-end voice roundtrip bypassing LLM |
| **LLM Reasoning TTFA** | $\le 1.8$ s | Phase 4 | End-to-end voice roundtrip with streaming TTS |
| **Ollama Token Generation** | $\ge 15$ tok/s | Phase 2 | Bonsai 2 4B generation rate on i7-10700 |

---

## 7. Container Orchestration & Image Pinning

All third-party Docker images are pinned to explicit release tags in [`docker-compose.yml`](./docker-compose.yml):

* `caddy:2.8.4-alpine` (TLS reverse proxy)
* `ollama/ollama:0.4.16` (Local LLM engine — active default model `qwen2.5:3b`)
* `rhasspy/wyoming-whisper:3.8.1` (faster-whisper STT)
* `rhasspy/wyoming-piper:1.6.2` (ONNX TTS)
* `node:20.18.1-alpine` (Node.js Active LTS for backend build & runner)
* `neptune-backend:0.1.0` (Fastify TypeScript engine)
* `neptune-asterisk:0.1.0` (Asterisk 20 PJSIP + Python AGI container)

### Image Update Policy
* Unpinned `latest` tags are prohibited.
* Image updates must be reviewed, tested in isolation, and updated via version-bump commits.

---

## 8. Build Validation & Status Transparency

### Why the Local `npm` Check Exited with Code 1
During repository validation, running `npm --version` in the agent's Windows shell failed with:
`npm : The term 'npm' is not recognized as the name of a cmdlet, function, script file, or operable program.`
This occurred because Node.js/npm is not installed on the Windows agent host path. The project is designed to build inside a container via `backend/Dockerfile` using Docker Engine on Debian.

### Status Delineation: Completed vs. Pending
* **Completed Statically:** File existence, folder structures, shell script syntax (`bash -n`), configuration files, and schema syntax.
* **Pending Live Execution:** Live `docker compose build`, container image pulling, TypeScript compilation inside the container, and network port binding on Debian. **We do not claim the backend builds successfully until a real build has been performed on the Debian VM.**

---

## 9. Security Architecture & Threat Model

* **Docker Socket Isolation:** To prevent root-equivalent privilege escalation, Docker execution is kept gated behind `sudo docker compose`. Users are not added to the `docker` group by default.
* **Untrusted Model Boundary:** The language model cannot execute arbitrary code or shell commands. Tool calls map strictly to explicit schemas (`ha_set_state`, `ha_set_climate`, `broadcast_announcement`, `telephony_call`, `media_control`) validated by `PermissionsGateway` and `TelephonyManager`.
* **Entity Whitelist (`config/allowed_entities.json`):** Only explicitly whitelisted entities (exact match or explicit trailing `*` wildcard) and permitted domains can be queried or modified.
* **Consequential Action Confirmation Gate:** High-consequence entities (`lock.*`, `cover.*`) are checked **before** `allowed_domains`, intercepted deterministically in `FastPathRouter`, and return `requires_confirmation: true` without executing (`v0.2.0` adds interactive `/api/confirm` approval flow).
* **Credential Isolation:** Home Assistant tokens and Jellyfin API keys live strictly in backend server environment variables (`.env`). The frontend receives zero credentials. Optional `NEPTUNE_API_KEY` header verification secures backend routes when set.
* **Persistence & Audit Logging:** Active reminders persist atomically to `data/reminders.json` (`.tmp` + rename). Operations log to container stdout; append-only SQLite `audit_logs` (`DATABASE_PATH`) is **Planned (`v0.2.0`)**.

---

## 10. Phased Implementation Roadmap & Acceptance Tests

| Phase | Test ID | Description | Acceptance Criteria (Targets) |
| :--- | :--- | :--- | :--- |
| **Phase 1** | `TEST-INF-01` | Proxmox Host & VM Memory Sizing | Host free RAM $\approx$ 5.0 GB baseline; VM 101 allocated 8.0 GB; VM 100 allocated 3.0 GB. |
| **Phase 1** | `TEST-INF-02` | Local TLS & Secure Context | Browser loading `https://neptune.home.arpa` establishes valid HTTPS without insecure context warning blocking `getUserMedia`. |
| **Phase 2** | `TEST-AI-01` | Ollama Bonsai 2 4B Execution | Model loads cleanly; RSS $\le$ 3.0 GB; generation speed target $\ge$ 15 tokens/sec. |
| **Phase 2** | `TEST-AI-02` | Structured Tool Calling | 20 test tool calls achieve 100% schema validity with zero missing parameters. |
| **Phase 3** | `TEST-VOX-01` | Whisper CPU Speed | 3-second audio clip transcribes in target $\le$ 450 ms with accurate text output. |
| **Phase 3** | `TEST-VOX-02` | Piper CPU Speed | 15-word response synthesizes to WAV in target $\le$ 200 ms on the i7-10700. |
| **Phase 4** | `TEST-SEC-01` | Entity Allowlist Enforcement | Queries targeting unlisted entities are rejected at gateway and logged in audit table. |
| **Phase 4** | `TEST-SEC-02` | Consequential Action Gate | Sensitive actions trigger confirmation prompt; auto-aborted after 30s. |
| **Phase 5** | `TEST-HA-01` | Home Assistant Control | Light toggle command executes via HA REST API and logs in $\le$ 100 ms. |
| **Phase 5** | `TEST-MED-01` | Jellyfin & Music Playback | Voice command queries Jellyfin via MASS and streams audio to chosen speaker. |
| **Phase 6** | `TEST-UI-01` | Mobile PTT Usability | PTT records on touch-start, transcribes on touch-end, and outputs audio on iOS/Android. |
| **Phase 6** | `TEST-UI-02` | Playback Interruption | Screen tap halts audio output within 50 ms and cancels backend synthesis. |
| **Phase 7** | `TEST-E2E-01` | End-to-End Voice Latency | Total Time-to-First-Audio target $\le$ 1.8 seconds. |
