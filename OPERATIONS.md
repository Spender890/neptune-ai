# NEPTUNE-AI: Operations & Maintenance Runbook

Welcome to the **Neptune-AI** operations guide. This manual provides day-to-day operational commands, maintenance routines, backup instructions, and architecture references.

---

## 1. Network Topology & Services Summary

| Service | Container / Machine | Host / Port | Internal Ports | Memory Usage |
| :--- | :--- | :--- | :--- | :--- |
| **Web Cockpit & TLS Proxy** | `neptune-caddy` | `neptune.home.arpa` / `<VM_IP>` | 80, 443 | ~15 MB |
| **Neptune Core Backend** | `neptune-backend` | `127.0.0.1:3000` | 3000 | ~70 MB |
| **Ollama LLM Engine** | `neptune-ollama` | `127.0.0.1:11434` | 11434 | ~2.7 GB (Qwen 2.5 3B) |
| **Wyoming Whisper (STT)** | `neptune-whisper` | `127.0.0.1:10300` | 10300 | ~1.0 GB (base.en) |
| **Wyoming Piper (TTS)** | `neptune-piper` | `127.0.0.1:10200` | 10200 | ~250 MB (lessac-medium) |
| **Asterisk Telephony PBX** | `neptune-asterisk` | `0.0.0.0:5060` | 5060/udp, 10000-10050/udp | ~65 MB |
| **Home Assistant OS** | Proxmox VM 100 | `<HAOS_IP>:8123` | 8123 | Independent VM |
| **Jellyfin Media Server** | WD Sentinel DX4000 | `<JELLYFIN_IP>:8096` | 8096 | Dedicated Server |

---

## 2. Daily Operations & CLI Shortcuts

All services are orchestrated via Docker Compose:

### View Live Status of All Containers
```bash
cd /opt/neptune
sudo docker compose ps
```

### View Live Resource Consumption (RAM & CPU)
```bash
sudo docker stats --no-stream
```

### View Real-Time Service Logs
```bash
# Core backend logs
sudo docker logs -f --tail 50 neptune-backend

# AI Reasoning logs
sudo docker logs -f --tail 50 neptune-ollama

# Asterisk Telephony logs
sudo docker logs -f --tail 50 neptune-asterisk
```

### Restart All Neptune Services
```bash
cd /opt/neptune
sudo docker compose restart
```

---

## 3. Telephony Extension Directory

Configure softphone apps (Linphone / Zoiper / Groundwire) with:
- **SIP Server / Domain:** `<NEPTUNE_AI_VM_IP>` or `neptune.home.arpa` (Port: `5060` UDP)
- **Transport:** UDP

| Extension | Purpose | Username | Password |
| :--- | :--- | :--- | :--- |
| **`7000`** | **Neptune-AI Voice Operator** | `7000` | Configured in `pjsip.conf` |
| **`1001`** | Primary Mobile Phone | `1001` | Configured in `pjsip.conf` |
| **`1002`** | Secondary Tablet / Deskphone | `1002` | Configured in `pjsip.conf` |

*Calling `7000` answers the line with bidirectional voice AI.*  
*Calling `1001` or `1002` rings the internal devices like an intercom.*

---

## 4. Backups & Disaster Recovery

Neptune persists data across Docker volumes and configuration files in `/opt/neptune`:
1. `/opt/neptune/.env` — Secrets and tokens.
2. `/opt/neptune/config/allowed_entities.json` — Whitelisted Home Assistant devices.
3. `/opt/neptune/config/contacts.json` — Telephony contact mapping.
4. `/opt/neptune/asterisk/` — Dialplan and SIP extensions.
5. Docker Volume `neptune_app_data` — Reminders and agenda store (`/app/data/reminders.json`).

### Run an Instant Backup
```bash
tar -czvf /opt/neptune-backup-$(date +%F).tar.gz /opt/neptune
```

---

## 5. Security & Access Control

1. **Permissions Gateway:** Only devices explicitly listed in `/opt/neptune/config/allowed_entities.json` can be controlled.
2. **Consequential Devices:** Locks and garage doors require verbal or interactive confirmation.
3. **Zero Cloud Ingress / Egress:** Whisper, Piper, Ollama, and Asterisk run 100% locally on your Intel Core i7 Proxmox host. No voice audio leaves your local network.
