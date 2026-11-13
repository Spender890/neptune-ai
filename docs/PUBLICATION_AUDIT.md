# Neptune-AI: Publication Accuracy & Technical Audit

**Audit Date:** 2026-11-14  
**Target Repository:** [Spender890/neptune-ai](https://github.com/Spender890/neptune-ai)  
**Auditor:** Systems & Security Audit Agent  
**Audit Scope:** Source Code Verification, Model Configuration, Security Claims, Infrastructure Orchestration, and Documentation Fidelity.

---

## 1. Executive Summary

This publication audit evaluates the Neptune-AI codebase to ensure that public documentation, architectural specifications, and portfolio claims reflect the actual code implementation. Discrepancies between historical design documentation and actual code have been cataloged and reconciled to establish a truthful, reproducible engineering artifact.

---

## 2. Discrepancy Matrix: Documentation vs. Implementation

| Subsystem / Area | Claim in Prior Documentation | Verified Code Reality | Reconciled Status |
| :--- | :--- | :--- | :--- |
| **Consequential Action Enforcement** | "Interactive confirmation dialog with 30s TTL" in `SECURITY.md` | Backend successfully blocks execution by returning early with `requires_confirmation: true`, but the frontend PWA lacks an interactive approval modal dialog | Clarified: Execution is refused/blocked by default; interactive confirmation loop is a documented roadmap item |
| **Audit Logging** | SQLite append-only audit table (`/app/data/neptune.sqlite`) in `SECURITY.md` | Pino structured JSON logging to stdout; no SQLite dependency installed | Documentation updated to reflect structured container stdout logging |
| **Input Validation** | "Strictly parsed into predefined Zod schemas" in `SECURITY.md` | Direct JSON schema validation via Ollama tools API and TypeScript guard branches | Documentation corrected to JSON schema tool definitions |
| **API Authentication** | Claimed per-request authenticated API endpoints in `SECURITY.md` | Endpoints rely on LAN / Caddy reverse-proxy network perimeter security; no Bearer token on `/api/command` | Clarified as network-perimeter authentication model |
| **Web Cockpit Voice** | "Push-to-Talk Web Audio MediaRecorder capture" in `README.md` | Web Cockpit PWA uses text command submission with simulated PTT toggle; real voice pipeline is in Asterisk AGI bridge | Documented exact interface responsibilities |
| **Docker Compose Pinning** | "All third-party images pinned to explicit semantic version tags" | `ollama/ollama:latest` was unpinned | Pinned to `ollama/ollama:0.4.16` |
| **Asterisk Networking** | `network_mode: host` claimed in `README.md` | Bridge network `neptune-net` with exposed port ranges `5060/udp` and `10000-10050/udp` | Reconciled README to document bridge configuration |
| **Environment Variables** | `BACKEND_PORT`, `OLLAMA_HOST`, `OLLAMA_PORT` in `README.md` table | Backend reads `NEPTUNE_PORT`, `OLLAMA_BASE_URL`, `LLM_MODEL` | Environment variable reference table reconciled |
| **Asterisk Container** | Missing from Step C.3 in `INSTALLATION.md` | Sixth core service (`neptune-asterisk:0.1.0`) is required for PBX functionality | Added to service list and verification step |

---

## 3. Model Configuration & Lifecycle

The model configurations across the lifecycle of the project are categorized as follows:

### 3.1. Current Production Model
- **Identifier:** `qwen2.5:3b` (Alibaba Qwen 2.5 3B parameters)
- **Quantization:** Standard 4-bit Medium (`Q4_K_M`, ~1.9 GB download / ~2.69 GiB active RAM resident)
- **Runtime:** Ollama on Intel Core i7-10700 CPU (AVX2 enabled)
- **Role:** Handles unstructured natural language queries, multi-turn conversational reasoning, and fallback tool execution.
- **Empirical Accuracy:** 20/20 (100%) structured tool-calling fidelity on Home Assistant service calls.
- **Measured Speed:** **9.68 tokens/second** generation rate, with total tool-calling latency averaging **3.36 s**.

### 3.2. Previously Benchmarked Model
- **Identifier:** `bonsai-2:4b` (Prism ML Bonsai 2 4B)
- **Architecture:** Ultralight ternary quantization
- **Measured Metrics:** 10.90 tok/sec generation rate, 445 MiB active RAM.
- **Outcome:** Replaced by `qwen2.5:3b` due to lower tool-calling accuracy (85%, failing climate and media resume intents). Retained in Ollama local cache as a low-RAM contingency model.

### 3.3. Alternative & Experimental Configurations
- **`qwen2.5:1.5b`:** Configured as lightweight fallback default in `backend/src/ollama.ts` constructor for resource-constrained nodes.
- **Faster-Whisper `base.en`:** Dedicated speech-to-text model on Wyoming TCP port 10300 (faster-whisper INT8 CPU inference).
- **Piper `en_US-lessac-medium`:** Dedicated ONNX neural voice model on Wyoming TCP port 10200.

---

## 4. Consequential-Action Security Verification

### 4.1. Current Implementation Analysis
Inspection of `backend/src/permissions.ts`, `backend/src/index.ts`, and `frontend/dist/index.html` reveals:
1. **Execution Prevention:** The backend **successfully prevents automated execution** of consequential actions (e.g. `lock.front_door`, `cover.garage_door`). When an entity matches `consequential_entities`:
   - FastPath returns early with `{ path: 'fast-path-confirmation-required', requires_confirmation: true }` without dispatching to Home Assistant.
   - LLM tool loops skip execution via `continue` when `permCheck.requires_confirmation` is true.
2. **Frontend Limitation:** The Web Cockpit PWA does not currently parse `requires_confirmation: true` or present an interactive approval dialog ("Approve / Deny"). As a result, consequential commands are safely blocked/refused, but cannot be completed interactively via the web UI.

### 4.2. Safe Implementation Proposal (Future Phase)
To close the confirmation loop without breaking existing contracts:
1. **Backend Pending State Store:** Introduce an in-memory queue (`Map<string, PendingAction>`) in `backend/src/index.ts` with a 30-second TTL.
2. **Confirmation Endpoint:** Add `POST /api/confirm` accepting `{ confirmation_id: string, decision: 'approve' | 'deny' }`.
3. **Frontend Modal Dialog:** Render an interactive modal banner when a response contains `requires_confirmation: true`, allowing one-click execution.

---

## 5. Docker Infrastructure & Version Pinning

### 5.1. Ollama Compatibility Analysis
- In `PROJECT_STATUS.md` line 28, historical benchmarking noted Ollama `v0.40.16` (a clerical typo for `v0.4.16`).
- Ollama version 0.4.x introduced native tool-calling JSON schema support via `/api/chat`.
- Pinning `ollama/ollama:0.4.16` in `docker-compose.yml` ensures:
  1. Strict adherence to the repository's semantic pinning policy.
  2. Guaranteed AVX2 CPU execution compatibility without discrete GPU overhead.
  3. Stable GGUF quantization parsing for `qwen2.5:3b`.

---

## 6. Testing Rigor & Claims Classification

To maintain high engineering standards for academic and portfolio review, testing claims must be categorized by verification depth:

### 6.1. Unit Tests vs. Integration Tests
- **Unit Tests:** Standalone mocked unit tests are not currently committed in `backend/test`.
- **Integration Tests:** The test suite consists of end-to-end integration test scripts (`scripts/verify-phase*.sh`) that validate running Docker containers via live HTTP REST calls, Wyoming TCP sockets, and Asterisk AGI execution.

### 6.2. Tool Calling: Single-Turn Dispatch vs. Autonomous Loops
- The LLM execution path in `backend/src/index.ts` is an **intent-to-tool dispatcher**.
- It parses user utterances into structured tool calls and executes them sequentially.
- It is not an autonomous recursive agent (it does not run multi-step plan-and-re-evaluate loops).

### 6.3. Verified vs. Unverified Long-Term Reliability
- **Verified:** Immediate command execution, FastPath routing latency (<10ms), TV HDMI ARC switching, outbound Asterisk `.call` spooling, and reminder creation.
- **Unverified:** Long-term memory leak behavior under multi-day continuous streaming, high-concurrency PBX stress testing (>5 simultaneous calls), and network reconnect recovery during extended upstream outages.
