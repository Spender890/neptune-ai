# Neptune-AI: Empirical Test Results & Verification Log

**Date:** 2026-11-14  
**Hardware Baseline:** Intel Core i7-10700 (8 Cores / 16 Threads, AVX2 enabled), 16.0 GB DDR4 Host RAM, Proxmox VE 8.x  
**Virtual Environment:** Debian 12 Bookworm Minimal VM (6 vCPUs, 8.0 GB RAM), Home Assistant OS VM (2 vCPUs, 3.0 GB RAM)

---

## Testing Rigor Disclaimer
> [!IMPORTANT]
> The tests documented below are strictly separated by methodology. Static checks confirm syntax and schema alignment only; they do not constitute proof of operational reliability or multi-subsystem stability under live network workloads.

---

## 1. Tier 1: Static Validation (Configuration & Syntax)

Automated non-destructive static analysis executed directly on repository files:

| Test Identifier | Target Component | Test Methodology | Result | Scope / Notes |
| :--- | :--- | :--- | :---: | :--- |
| **TEST-CFG-01** | `config/allowed_entities.json` | JSON Schema Parser | **PASS** | Valid JSON syntax; correct entity allowlist format |
| **TEST-CFG-02** | `config/contacts.json.example` | JSON Schema Parser | **PASS** | Valid extension array and alias structure |
| **TEST-CFG-03** | `backend/package.json` | JSON Schema Parser | **PASS** | Valid manifest and package dependencies |
| **TEST-CFG-04** | `backend/tsconfig.json` | JSON Schema Parser | **PASS** | Valid TypeScript compiler configuration |
| **TEST-PY-01** | `scripts/asterisk-voice-agent.py` | Python Bytecode Compilation | **PASS** | Zero syntax errors, valid AGI handler |
| **TEST-PY-02** | `scripts/benchmark-voice-phase3.py`| Python Bytecode Compilation | **PASS** | Valid Wyoming client test harness |
| **TEST-DOCK-01**| `docker-compose.yml` | Service Topology Audit | **PASS** | All 6 services present and networked |
| **TEST-DOCK-02**| `docker-compose.yml` | Semantic Version Pinning | **PASS** | Caddy, Whisper, Piper, Ollama pinned |
| **TEST-SEC-01** | Repository Tree | Deep Pattern Scan | **PASS** | Zero exposed SIP passwords or private LAN IPs |

---

## 2. Tier 2: Unit Testing Status

- **Status:** **Not Implemented / None Present in Repository.**
- **Details:** The repository does not currently contain isolated component unit tests with mocked external APIs (e.g. mocked Home Assistant REST endpoints or virtual Asterisk sockets).
- **Assessment:** All automated runtime tests currently operate as integration or end-to-end tests against live containerized services.

---

## 3. Tier 3: Integration Testing

Automated bash and python integration harnesses validating inter-service contracts:

### 3.1. FastPath Intent Routing (`scripts/verify-phase4-backend.sh`)
- **Latency Benchmark:** **3 ms – 8 ms**
- **Test Set:** 7 standard commands covering lights, TV playback, volume, and climate.
- **Result:** 7/7 (100%) matched via pre-compiled regex router with zero CPU throttling.

### 3.2. Model Tool-Calling Fidelity (`scripts/benchmark-phase2.sh`)
- **Evaluated Models:** `bonsai-2:4b` vs `qwen2.5:3b` on Intel Core i7-10700 CPU.
- **Test Set:** 20-case structured tool-calling benchmark against Home Assistant service schemas.
- **Results:**
  - `qwen2.5:3b`: **20 / 20 (100% Pass)**. Accurately extracted HVAC temperatures, media resume actions, and avoided hallucinating tools on conversational inputs.
  - `bonsai-2:4b`: **17 / 20 (85% Pass)**. Failed 2/2 climate prompts and media resume.

### 3.3. Neural Speech Pipeline (`scripts/verify-phase3-voice.sh`, `scripts/benchmark-voice-phase3.py`)
- **Wyoming Whisper (STT):** Transcribed a 3.5s audio utterance in **1.20 s – 1.65 s** on CPU using `base.en`.
- **Wyoming Piper (TTS):** Time-to-First-Audio (TTFA) measured at **150 ms – 220 ms** using `en_US-lessac-medium` ONNX model (real-time factor ~0.15).

### 3.4. LG webOS TV & Media Streaming (`scripts/verify-phase5-tv.sh`)
- **Test Set:** Power, volume adjustment, app launching (YouTube, Netflix), and on-screen toast notifications.
- **Results:** 7/7 Passed (Average latency < 25 ms).
- **Audio Output Redirection:** Toggling `sound_output` between `tv_speaker` and `external_arc` / `optical` verified functional for whole-house amplifier integration.

### 3.5. Telephony PBX Integration (`scripts/verify-phase7-telephony.sh`)
- **PJSIP Endpoints:** Extensions 1001, 1002, and 7000 verified registered and responsive.
- **Dialplan Reload:** Clean reload with zero dialplan syntax warnings.

---

## 4. Tier 4: End-to-End Acceptance Testing

Full multi-step conversational and messaging flows (`scripts/verify-phase8-complete-features.sh`):

1. **Inbound Operator Dialog:** Calling extension 7000 triggers Asterisk $\rightarrow$ AGI $\rightarrow$ Caller ID identification $\rightarrow$ Piper personalized greeting $\rightarrow$ Whisper STT transcription $\rightarrow$ FastPath/LLM backend dispatch $\rightarrow$ Piper speech playback.
2. **Outbound Intercom Dispatch:** Command *"Call Desk and tell them dinner is ready"* generates an Asterisk `.call` spool file with `MaxRetries: 0`, initiating an outbound SIP call that delivers the message upon answer in **< 20 ms**.
3. **Synchronized Reminder Broadcast:** Timer expiration triggers simultaneous LG TV on-screen toast, Home Assistant VLC-Telnet whole-house speaker announcement, and Asterisk mobile softphone call.

---

## 5. Tier 5: Manual & Hardware Testing

Conducted directly on physical devices within the local network:
- **Client Softphones:** Linphone verified on Android and iOS devices connected over local Wi-Fi.
- **Smart TV:** LG QNED806QA webOS Smart TV verified via Wake-on-LAN and HDMI ARC amplifier link.
- **Audio Output:** 3.5mm host AUX hardware output verified via QEMU ALSA bridge to physical whole-house amplifier.

---

## 6. Tier 6: Long-Duration Reliability & Stress Testing

- **Status:** **Unverified / Roadmap Item.**
- **Unverified Dimensions:**
  - Multi-day continuous uptime memory leak profiling on Fastify and Python AGI.
  - High-concurrency PBX stress testing (>5 simultaneous active SIP channels on CPU).
  - Extended network partition recovery and automatic reconnect behavior during prolonged upstream outages.
