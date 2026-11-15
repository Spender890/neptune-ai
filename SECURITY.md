# NEPTUNE-AI — Security Architecture & Threat Model

Security is fundamental to Neptune-AI. A locally hosted assistant must never become a vector for unauthorized home device actuation, credential exposure, or host privilege escalation.

---

## 1. Core Security Principles

1. **Zero-Trust Language Model Boundary:** The local LLM is treated as an untrusted reasoning engine. It cannot execute arbitrary shell commands, raw SQL, or unrestricted network calls.
2. **Least-Privilege Container & Host Isolation:** Membership in the `docker` group grants root-equivalent privileges on the host. Neptune-AI documents `sudo docker compose` administration in `INSTALLATION.md` *(note: an earlier VM helper option may add the operator user to `docker` only if explicitly desired — audit `/etc/group` accordingly)*. The Node backend runs as non-root `USER node`; `neptune-asterisk` sets `user: root` in `docker-compose.yml` only for shared spool mount permissions and drops privileges internally via `runuser = asterisk` in `asterisk/asterisk.conf`.
3. **Strict Entity Whitelisting:** Smart home devices are denied access by default. Only entities explicitly matching `config/allowed_entities.json` (exact match or explicit trailing `*` wildcard, validated by strict regexes) are exposed to the AI for inspection or actuation.
4. **Defense-in-Depth for Physical Actions:** High-consequence entities (`consequential_entities`: door locks, garage doors, covers) are evaluated **before** `allowed_domains`, captured deterministically in `FastPathRouter`, and blocked from automatic execution by returning `requires_confirmation: true`. *(Interactive web confirmation execution `/api/confirm` is planned for `v0.2.0`.)*
5. **Secret Isolation & Optional API Auth:** High-privilege tokens (`HOMEASSISTANT_TOKEN`, `JELLYFIN_API_KEY`) live strictly in backend server environment variables (`.env`) and are URL-encoded before outbound HTTP/HTTPS calls. Setting `NEPTUNE_API_KEY` enforces `X-API-Key` / `Authorization: Bearer` authentication on all backend endpoints except `/api/health`.
6. **No Automatic Host Modification:** Infrastructure scripts provided by Neptune-AI (`scripts/host-tuning.sh`) are strictly read-only. Scripts never format disks, delete VMs, or modify hypervisor kernel parameters automatically.
7. **Asterisk `.call` & Web UI Sanitization:** Every dynamic string interpolated into Asterisk `.call` spool files strips `\r`, `\n`, `\0`, and quotes; emergency numbers (`911`, `999`, `112`, `000`, `110`, `119`, `988`) and external phone numbers are blocked. All reminder fields rendered in `frontend/dist/index.html` are HTML-escaped via `escapeHtml()` before `innerHTML` insertion.

---

## 2. Threat Modeling & Applied Safeguards

| Threat Vector | Risk Level | Applied Safeguard |
| :--- | :--- | :--- |
| **Docker Daemon Privilege Escalation** | Critical | Users are **not** added to the `docker` group. Docker commands require `sudo`. Containers run with non-root internal users where supported (e.g. `node` in backend). |
| **Prompt Injection / Jailbreak** | High | The LLM does not execute raw instructions as code. Tool invocations are strictly validated against predefined JSON schemas with entity allowlist checks before interacting with Home Assistant. |
| **Accidental Physical Actuation** | Critical | Actions affecting high-consequence entities (doors, locks) return `requires_confirmation: true` and prompt the user for explicit confirmation before execution. |
| **Credential Leakage** | High | The frontend PWA communicates strictly with `/api` and `/ws` over local TLS via Caddy. Client devices never hold Home Assistant bearer tokens or Jellyfin credentials. |
| **Network Eavesdropping** | Medium | Internal TLS terminates on Caddy with automated certificates and secure proxying. Endpoints are isolated on the local home network. |
| **Resource Exhaustion** | Medium | Ollama concurrency is locked to `OLLAMA_NUM_PARALLEL=1` to guarantee the 8.0 GB RAM budget is never exceeded. |

---

## 3. Entity Whitelist Specification (`config/allowed_entities.json`)

The security gateway verifies all tool invocations against `allowed_entities.json`:

```json
{
  "allowed_entities": [
    "light.living_room",
    "light.kitchen",
    "light.bedroom",
    "switch.desk_fan",
    "climate.thermostat",
    "media_player.living_room_speaker"
  ],
  "allowed_domains": [
    "light",
    "switch",
    "climate",
    "media_player",
    "timer",
    "sensor",
    "binary_sensor"
  ],
  "consequential_entities": [
    "lock.front_door",
    "cover.garage_door"
  ]
}
```

* **`allowed_domains`**: High-level categories permitted for automation. Any entity belonging to unlisted domains (e.g. `automation`, `script`, `shell_command`) is immediately rejected.
* **`consequential_entities`**: Entities that trigger the manual confirmation dialog on the frontend before any execution payload is sent to Home Assistant.

---

## 4. Consequential Action Confirmation Flow

### Current Behavior (`v0.1.0` — Fail-Safe Block)
```
User: "Unlock the front door"
       |
       v
FastPathRouter (deterministic ha_lock) -> PermissionsGateway checks `consequential_entities` BEFORE `allowed_domains`
       |
       v
MATCHES sensitive entity (`lock.front_door`)
       |
       +--> Backend DOES NOT call Home Assistant (blocked cleanly)
       +--> Returns `requires_confirmation: true` & confirmation speech prompt
       |    (Same guard applies if an LLM tool call targets a consequential entity)
```

> [!NOTE]
> **Planned (`v0.2.0`):** Two-step tokenized interactive confirmation (`/api/confirm`) with 30-second TTL and Web UI Approve/Deny modal. Until shipped, consequential lock and cover entities remain safely blocked from unattended execution.

---

## 5. Network Security Assumptions & API Authentication

1. **Network Perimeter:** Neptune-AI is designed for **private trusted LANs / VLANs only** — never expose Caddy ports (`80`/`443`), Ollama (`11434`), Whisper (`10300`), Piper (`10200`), or Asterisk SIP (`5060`) directly to the public internet.
2. **Optional API Key Protection (`NEPTUNE_API_KEY`):** By default (when `NEPTUNE_API_KEY` is unset in `.env`), API routes assume a trusted home LAN. On shared or multi-user networks, set a strong random `NEPTUNE_API_KEY` in `.env` and configure SIP clients / tools to send `X-API-Key: <key>` or `Authorization: Bearer <key>`. `/api/health` remains unauthenticated for container healthchecks.
3. **SIP Password Hygiene (`asterisk/pjsip.conf`):** Tracked `asterisk/pjsip.conf` contains safe `CHANGE_ME_*` placeholders. Before editing live passwords locally, run:
   ```bash
   git update-index --skip-worktree asterisk/pjsip.conf
   ```
   to prevent accidental credential pushes in pull requests.
4. **Jellyfin API Key Transport:** For compatibility across Jellyfin 10.9 endpoints, `JellyfinClient` passes `JELLYFIN_API_KEY` via both the `X-Emby-Token` / `Authorization` headers and `?ApiKey=...` query parameters. Ensure reverse-proxy access logs on the Jellyfin host do not retain sensitive query strings in untrusted shared log aggregators.

---

## 6. Container Logging & Telemetry

All backend operations are logged to container standard output (`stdout` / `stderr`) captured by Docker Engine without writing HA tokens or Jellyfin API keys to disk. A persistent SQLite audit log (`audit_logs`) is planned for `v0.2.0`.

---

## 7. Reporting a Vulnerability

If you discover a security issue in Neptune-AI (injection vector, authentication bypass, container privilege escalation, or accidental secret exposure):

1. **Do NOT open a public GitHub issue** with exploit details or sensitive logs.
2. Report privately via **GitHub Security Advisories** (`Security` tab -> `Report a vulnerability` on `https://github.com/Spender890/neptune-ai/security/advisories`).
3. Include affected commit/version, reproduction steps (sanitized of real tokens/IPs), and potential impact. Maintainers target initial acknowledgment within 72 hours.
