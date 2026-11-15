# Neptune-AI — Defensive Security Review

**Review Date:** 2026-11-15  
**Scope:** Source code (`backend/src/`, `frontend/dist/`, `scripts/`), container configuration (`docker-compose.yml`, `*/Dockerfile`, `Caddyfile`), Asterisk PBX configs (`asterisk/*.conf*`), Git history, and `.env.example`.  
**Methodology:** Static source review, configuration inspection, threat modeling, and automated unit/boundary verification (no external or destructive tests performed).

---

## 1. Executive Summary & Risk Matrix

Overall, Neptune-AI follows sound foundational principles: local-only inference, entity allowlisting (`config/allowed_entities.json`), non-root Node backend container (`USER node`), localhost-bound internal services (`127.0.0.1`), and non-destructive host scripts.

However, the defensive audit uncovered **1 Critical, 3 High, and 4 Medium** security findings in the codebase and configuration that needed remediation prior to public release.

| ID | Severity | Category | Summary | Remediation Status |
| :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | **Critical** | Command / Dialplan Injection | Unsanitized newline injection into Asterisk `.call` spool files (`agenda.ts`, `telephony.ts`) | **Fixed** |
| **SEC-02** | **High** | Cross-Site Scripting (XSS) | Stored DOM XSS via unescaped `innerHTML` in Web Cockpit (`frontend/dist/index.html`) | **Fixed** |
| **SEC-03** | **High** | Authorization / Safety Gate Bypass | Unreachable `consequential_entities` confirmation check (`permissions.ts`) & missing LLM gate handling | **Fixed** |
| **SEC-04** | **High** | Telephony Abuse / Safety Policy | Unrestricted numeric extraction allowed dialing arbitrary/emergency numbers (`telephony.ts`) | **Fixed** |
| **SEC-05** | **Medium** | Authorization Bypass | Entity allowlist prefix-matching flaw (`entity_id.startsWith(e)`) in `permissions.ts` | **Fixed** |
| **SEC-06** | **Medium** | Path Traversal | Unencoded `domain`, `service`, `entity_id`, and `sessionId` in upstream HTTP URLs | **Fixed** |
| **SEC-07** | **Medium** | API Exposure & Input Validation | No optional API key auth for non-localhost use; missing input bounds checks | **Fixed** |
| **SEC-08** | **Medium** | Secrets & Container Privileges | Tracked `asterisk/pjsip.conf` risks credential commit; `user: root` on Asterisk container | **Mitigated / Documented** |
| **SEC-09** | **Low** | Secrets in Git & Logs | No real secrets found in Git history; tokens not logged in Pino output | **Verified Clean** |
| **SEC-10** | **Low** | Prompt Injection Boundary | LLM cannot execute shell directly, but tool arguments must pass strict validation | **Verified / Strengthened** |

---

## 2. Detailed Security Findings

### SEC-01 (Critical): Asterisk `.call` File Newline / Header Injection
- **Evidence:**
  - `backend/src/agenda.ts:93-94`:
    ```ts
    `Set: REMINDER_MSG=${rem.title.replace(/"/g, "'")}`,
    `Set: OUTBOUND_TO=${contact ? contact.name : recipient}`,
    ```
  - `backend/src/telephony.ts:62,69,70`: `sender` and `recipientName` were interpolated into `CallerID`, `Set: OUTBOUND_TO`, and `Set: OUTBOUND_FROM` without stripping `\r` or `\n` (only `cleanMsg` stripped newlines).
- **Impact:** Asterisk `.call` files are line-oriented key-value directives. A reminder title or sender string containing `\nApplication: System\nData: ...` could inject arbitrary Asterisk dialplan applications into the spooled call file.
- **Recommended Fix:** Strip all CR, LF, and NUL bytes (`[\r\n\0]`) from every field written to `.call` files (`title`, `recipient`, `sender`, `cleanMsg`), validate `targetExt` strictly against `/^[0-9]{3,6}$/`, and restrict characters to safe printable text.
- **Status:** **Fixed** in `backend/src/agenda.ts` and `backend/src/telephony.ts`.

### SEC-02 (High): Stored DOM XSS in Web Cockpit (`frontend/dist/index.html`)
- **Evidence:** `frontend/dist/index.html:682-711` constructed HTML strings using template literals with `rem.title`, `rem.created_by`, `rem.target_person`, `rem.channels`, and `rem.id`, and assigned them directly to `remindersContainer.innerHTML`.
- **Impact:** Any reminder created via `/api/reminders` or `/api/command` containing HTML/script tags (e.g., `<img src=x onerror=alert(1)>`) executes arbitrary JavaScript in any browser viewing the cockpit.
- **Recommended Fix:** Implement `escapeHtml()` and encode all dynamic fields before rendering into DOM, plus sanitize `rem.id` in click handlers.
- **Status:** **Fixed** in `frontend/dist/index.html`.

### SEC-03 (High): Unreachable Consequential-Action Confirmation Gate
- **Evidence:**
  - `backend/src/permissions.ts:35-42` evaluated `allowed_domains` **before** checking `consequential_entities`. Because `config/allowed_entities.json` only lists `light`, `switch`, `climate`, `media_player`, `webostv`, `timer`, `sensor`, `binary_sensor`, `tts`, `asterisk` in `allowed_domains` — omitting `lock` and `cover` — `lock.front_door` and `cover.garage_door` returned `{ allowed: false, requires_confirmation: false }` instead of `requires_confirmation: true`.
  - `backend/src/fastpath.ts` had no regex pattern for locks or covers, so *"unlock the front door"* fell through to Ollama.
  - `NeptuneEngine` (`backend/src/engine.ts`) previously did not propagate `requires_confirmation: true` back to the client on the LLM tool-calling path.
- **Impact:** Consequential entity policy was broken/dead code, and LLM tool calls did not signal confirmation-required responses.
- **Recommended Fix:** Check `this.config.consequential_entities.includes(entity_id)` first (still validating format), add deterministic FastPath matching for `lock`/`unlock` and `open`/`close` doors/covers so they are never routed to an LLM, and propagate `requires_confirmation: true` on LLM tool-calling paths.
- **Status:** **Fixed** in `backend/src/permissions.ts`, `backend/src/fastpath.ts`, and `backend/src/engine.ts`.

### SEC-04 (High): Unrestricted Telephony Digit Extraction (Emergency & External Dialing)
- **Evidence:** `backend/src/telephony.ts:32` computed `const targetExt = contact ? contact.extension : req.recipientQuery.replace(/\D/g, '');`.
- **Impact:** Prompts such as *"Call 911 and tell them..."* or *"Call 15551234567 and say..."* extracted raw digits and generated `.call` files for `PJSIP/911` or arbitrary numbers, violating the project's safety constraint against dialing emergency numbers or unapproved external numbers.
- **Recommended Fix:** Explicitly block emergency numbers (`911`, `999`, `112`, `000`, `110`, `119`, `988`) and restrict dialing exclusively to resolved contacts in `CONTACT_DIRECTORY` or valid local SIP extensions (`1001`–`1009`, `7000`, or configured extensions).
- **Status:** **Fixed** in `backend/src/telephony.ts`.

### SEC-05 (Medium): Entity Allowlist Prefix-Matching Bypass
- **Evidence:** `backend/src/permissions.ts:46` used `entity_id.startsWith(e) || e === entity_id`.
- **Impact:** Allowing `light.kitchen` implicitly allowed any entity beginning with that prefix, such as `light.kitchen_override` or `light.kitchen_high_voltage_relay`.
- **Recommended Fix:** Enforce exact equality (`e === entity_id`), supporting prefix matching only when an entry explicitly ends with `*` (e.g., `light.kitchen_*`).
- **Status:** **Fixed** in `backend/src/permissions.ts`.

### SEC-06 (Medium): Unencoded Path Segments in Upstream HTTP Requests
- **Evidence:** `backend/src/homeassistant.ts:33,82` built `${this.baseUrl}/api/services/${domain}/${service}` and `${this.baseUrl}/api/states/${entity_id}` directly from arguments; `backend/src/jellyfin.ts:164` interpolated `sessionId` and `itemId`.
- **Impact:** If the LLM generated a `domain`, `service`, or `entity_id` containing `../` or `?`, it could traverse Home Assistant API paths (e.g., reading `/api/config`).
- **Recommended Fix:** Validate strict Home Assistant identifier syntax (`/^[a-z0-9_]+$/` for domains/services, `/^[a-z0-9_]+\.[a-z0-9_]+$/` for `entity_id`) in `PermissionsGateway` and apply `encodeURIComponent()` in `HomeAssistantClient` and `JellyfinClient`.
- **Status:** **Fixed**.

### SEC-07 (Medium): API Exposure, Input Bounds & Authentication Assumptions
- **Evidence:** `backend/src/index.ts` bound `0.0.0.0:3000` inside container (`127.0.0.1:3000` on host via `docker-compose.yml:140`), proxied over LAN HTTPS via Caddy (`0.0.0.0:443`). No request length limits or optional API token check existed.
- **Impact:** Anyone on the local LAN (including guests or compromised IoT devices) can send commands to `/api/command`, create reminders, or initiate intercom calls if no API key is configured. Oversized payloads could waste Ollama CPU cycles.
- **Recommended Fix:**
  - Keep `/api/health` open for Docker healthchecks.
  - Add optional `NEPTUNE_API_KEY` authentication support via `Authorization: Bearer <key>` or `X-API-Key: <key>` on API routes (defaulting to disabled only for local trusted LAN compatibility, clearly documented in `SECURITY.md` and `.env.example`).
  - Enforce string length bounds on `text` (`<= 1000` chars), reminder titles (`<= 250` chars), and sound output allowlist.
- **Status:** **Fixed** in `backend/src/index.ts` and `backend/src/reminders.ts`.

### SEC-08 (Medium): SIP Credentials File Tracking & Asterisk Container Privileges
- **Evidence:**
  - `asterisk/pjsip.conf` is tracked in Git with `password=CHANGE_ME_STRONG_SIP_SECRET_1001`, while `INSTALLATION.md:194` instructs users to copy `pjsip.conf.example` over `pjsip.conf` and edit passwords. If a contributor runs `git add -A` later, live SIP passwords could be pushed.
  - `docker-compose.yml:161` explicitly overrides `user: root` on `neptune-asterisk`, even though `asterisk/Dockerfile:18` sets `USER asterisk` and `asterisk/asterisk.conf:29-30` configures `runuser = asterisk`.
- **Impact:** Potential accidental credential commit by users; Asterisk container runs as `root` unnecessarily (though Asterisk drops privileges internally if `runuser = asterisk` works, starting as `root` weakens container isolation).
- **Recommended Fix:**
  - Document `git update-index --skip-worktree asterisk/pjsip.conf` or bind-mounting a local override in `INSTALLATION.md` and `SECURITY.md` (keeping `asterisk/pjsip.conf` valid for default compose runs without breaking existing deployments).
  - Document why `user: root` is used in `docker-compose.yml` (shared bind mount `./data/outgoing` permission alignment and `runuser = asterisk` privilege drop) and how to harden with matched UID/GID.
- **Status:** **Mitigated & Documented**.

---

## 3. Additional Security Checks Performed

1. **Secrets in Git History (`git log -p` / full file inspection):**
   - Inspected both commits (`5f2a018`, `9af7de9`). Zero live API tokens, Home Assistant tokens, Jellyfin keys, private keys (`.pem`/`.key`), or real SIP passwords are present. All placeholders (`your_ha_long_lived_access_token_here`, `CHANGE_ME_STRONG_SIP_SECRET_*`) are non-secret templates.
2. **Sensitive Data in Logs:**
   - `HomeAssistantClient`, `JellyfinClient`, `OllamaAgent`, and `index.ts` do not log bearer tokens or API keys. Note: `JellyfinClient` currently sends `ApiKey` in both the `Authorization` header and URL query string (`?ApiKey=...`) for Jellyfin compatibility; proxy logs on the Jellyfin host could record query parameters. Documented in `SECURITY.md` and recommended preferring the `Authorization` header in future Jellyfin versions.
3. **Unsafe Deserialization:**
   - All JSON parsing uses native `JSON.parse()` inside `try/catch`; no `eval()`, `Function()`, `vm`, `pickle`, or `yaml.load` is used in TypeScript or Python code.
4. **LLM Prompt Injection & Command Execution Boundary:**
   - No shell invocation (`child_process.exec`/`spawn`) exists anywhere in `backend/src/`.
   - Deterministic `FastPathRouter` is evaluated strictly **before** `OllamaAgent`.
   - Tool calls returned by Ollama are validated through `PermissionsGateway` before reaching Home Assistant, and `telephony_call` invokes `TelephonyManager` with strict contact/extension allowlisting and newline sanitization.
5. **Network Binding Defaults:**
   - `docker-compose.yml` binds `ollama` (`11434`), `whisper` (`10300`), `piper` (`10200`), and `neptune-backend` (`3000`) strictly to `127.0.0.1` on the host.
   - Only Caddy (`80`, `443`) and Asterisk (`5060/udp`, `10000-10050/udp`) are exposed on LAN interfaces (`0.0.0.0`).
   - **Network Security Assumption:** Neptune-AI assumes deployment behind a trusted home LAN router/firewall (no direct WAN port forwarding). Placing Caddy or Asterisk UDP 5060 directly on the public Internet without VPN/SIP firewalling is explicitly unsupported.
6. **Dependency Vulnerability Audit Status:**
   - `backend/package.json` depends only on `fastify` (`^4.26.2`) at runtime (`typescript` and `@types/node` in `devDependencies`). Because `npm` is not installed on the Windows audit host, `npm audit` could not run locally; `.github/workflows/ci.yml` adds automated `npm audit --audit-level=high` on every PR/push.
