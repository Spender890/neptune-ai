# NEPTUNE-AI — Security Architecture & Threat Model

Security is fundamental to Neptune-AI. A locally hosted assistant must never become a vector for unauthorized home device actuation, credential exposure, or host privilege escalation.

---

## 1. Core Security Principles

1. **Zero-Trust Language Model Boundary:** The local LLM is treated as an untrusted reasoning engine. It cannot execute arbitrary shell commands, raw SQL, or unrestricted network calls.
2. **Docker Socket & Host Isolation:** Membership in the `docker` group grants root-equivalent privileges (any user in `docker` can mount `/` inside a container and modify host files). For security, Neptune-AI leaves the user outside the `docker` group and gates Docker commands behind `sudo`.
3. **Strict Entity Whitelisting:** Smart home devices are denied access by default. Only entities explicitly listed in `config/allowed_entities.json` are exposed to the AI for inspection or actuation.
4. **Defense-in-Depth for Physical Actions:** High-consequence actions (door locks, garage doors, security alarm panels, master power cutoffs) cannot be executed automatically through speech parsing alone. They require a mandatory confirmation dialog on the client device.
5. **Secret Isolation:** High-privilege tokens (Home Assistant long-lived tokens, Jellyfin API keys) are restricted to backend server memory and server `.env` files. The frontend client receives zero API secrets.
6. **No Automatic Host Modification:** Infrastructure scripts provided by Neptune-AI are non-destructive and strictly read-only by default. Scripts never format disks, delete VMs, or modify hypervisor kernel parameters automatically.
7. **Immutable Local Audit Trail:** Every incoming speech utterance, recognized intent, tool call, parameter set, confirmation response, and Home Assistant response is logged to an append-only SQLite audit table (`/app/data/neptune.sqlite`).

---

## 2. Threat Modeling & Applied Safeguards

| Threat Vector | Risk Level | Applied Safeguard |
| :--- | :--- | :--- |
| **Docker Daemon Privilege Escalation** | Critical | Users are **not** added to the `docker` group. Docker commands require `sudo`. Containers run with non-root internal users where supported (e.g. `node` in backend). |
| **Prompt Injection / Jailbreak** | High | The LLM does not execute raw instructions as code. Tool invocations are strictly parsed into predefined Zod schemas with entity whitelist checks before interacting with Home Assistant. |
| **Accidental Physical Actuation** | Critical | Actions affecting doors, locks, or heating systems trigger a `PENDING_CONFIRMATION` event. The action is held for 30 seconds awaiting manual UI approval; unconfirmed actions are discarded. |
| **Credential Leakage** | High | The frontend PWA communicates strictly with `/api` and `/ws` over local TLS via Caddy. Client devices never hold Home Assistant bearer tokens or Jellyfin credentials. |
| **Network Eavesdropping** | Medium | Internal TLS terminates on Caddy with strict HTTP Strict Transport Security (HSTS) and secure WebSocket encapsulation. Standardized domain: `neptune.home.arpa`. |
| **Denial of Service / Resource Exhaustion** | Medium | Ollama concurrency is locked to `OLLAMA_NUM_PARALLEL=1` to guarantee the 8.0 GB RAM budget is never exceeded. Rate limiting is applied at the Fastify gateway. |

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

```
User: "Unlock the front door"
       |
       v
Backend checks `consequential_entities`
       |
       v
Action MATCHES sensitive entity: `lock.front_door`
       |
       +--> Backend freezes execution
       +--> Generates unique `confirmation_id` with 30s TTL
       +--> Pushes prompt to client: "Confirm unlocking front door? [Approve] [Deny]"
       |
       +--- IF Approved: Service call sent to HA; event logged in audit table.
       +--- IF Denied or Expired (30s): Action discarded; response: "Action cancelled."
```

---

## 5. Audit Logging Schema

All interactions are recorded in SQLite (`/app/data/neptune.sqlite`) under the `audit_logs` table:

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    client_ip TEXT NOT NULL,
    session_id TEXT NOT NULL,
    input_type TEXT CHECK(input_type IN ('voice', 'text')),
    transcript TEXT NOT NULL,
    matched_intent TEXT,
    tool_called TEXT,
    tool_arguments TEXT,
    is_consequential INTEGER DEFAULT 0,
    confirmation_status TEXT CHECK(confirmation_status IN ('none', 'approved', 'rejected', 'timeout')),
    execution_result TEXT,
    error_message TEXT
);
```
