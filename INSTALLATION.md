# NEPTUNE-AI — Infrastructure & Phase 1 Deployment Guide

This guide provides an ordered, verifiable manual installation procedure for Neptune-AI Phase 1.

### Target Architecture Overview
* **Supported Operating Systems:** Debian 12 (primary tested target), Ubuntu 22.04/24.04 LTS x86-64 (for Docker host).
* **CPU & Hardware Requirements:** x86-64 CPU with **AVX2** support (required by `faster-whisper` and Ollama CPU inference), minimum **8.0 GB RAM** dedicated to the Neptune AI stack (plus ~3.0 GB if self-hosting Home Assistant OS in a separate VM), ~20 GB free disk for container images and `qwen2.5:3b` weights. No discrete GPU required.
* **Two Supported Topologies:**
  1. **Standalone Linux Docker Host (Quickstart below):** Run Neptune-AI containers directly on any Linux machine with Docker Compose v2, pointing `.env` at your existing Home Assistant and Jellyfin LAN instances.
  2. **Proxmox VE Two-VM Lab (Parts A–D below):** VM 100 (`HAOS`, 3.0 GB RAM, 2 vCPUs) + VM 101 (`Debian 12 AI`, 8.0 GB RAM, 6 vCPUs) + external NAS (`Jellyfin`).

---

## Standalone Quickstart (Any Debian/Ubuntu Docker Host)

If you already run Home Assistant on your LAN and want to deploy Neptune-AI on a single Linux host without Proxmox VE:

1. **Install Prerequisites:** Docker Engine (`>= 24`), Docker Compose plugin (`v2+`), and `git`.
2. **Clone & Configure:**
   ```bash
   git clone https://github.com/Spender890/neptune-ai.git /opt/neptune
   cd /opt/neptune
   cp .env.example .env
   cp config/contacts.json.example config/contacts.json
   git update-index --skip-worktree asterisk/pjsip.conf
   cp asterisk/pjsip.conf.example asterisk/pjsip.conf
   ```
   Edit `.env` (`HOMEASSISTANT_URL`, `HOMEASSISTANT_TOKEN`, `TV_ENTITY_ID`, `SPEAKER_ENTITY_ID`, optional `NEPTUNE_API_KEY`) and replace `CHANGE_ME_STRONG_SIP_SECRET_*` passwords inside `asterisk/pjsip.conf`.
3. **Verify Config, Build & Start:**
   ```bash
   sudo docker compose config -q
   sudo docker compose build
   sudo docker compose up -d
   ```
4. **Download the Local LLM Model (First Run):**
   ```bash
   sudo docker compose exec ollama ollama pull qwen2.5:3b
   ```
5. **Verify Health:**
   ```bash
   sudo docker compose ps
   curl -fsS http://127.0.0.1:3000/api/health
   ```
   Expect JSON with `"status": "ok"` and `"version": "0.1.0"`. Review `config/allowed_entities.json` and `Caddyfile` (`neptune.home.arpa` LAN DNS) before enabling client access.

---

> Below is the full **Proxmox VE Dual-VM** deployment procedure (`VM 100 HAOS` + `VM 101 Debian 12`) with read-only host audit and non-destructive defaults.

## Part A: Proxmox VE Host (Commands to Run on Proxmox Shell as `root`)

### Step A.1: Proxmox Host Storage & Memory Audit (Read-Only)
Inspect host memory and active storage cache.

* **Action (Proxmox Shell):**
  ```bash
  chmod +x scripts/host-tuning.sh
  ./scripts/host-tuning.sh
  ```
* **Verification Command:**
  Script completes with exit code 0 and reports physical host RAM, active storage subsystem (ZFS, LVM-thin, or ext4), and current ARC limits.
* **Expected Output:**
  `[ASSESSMENT] Sizing provides comfortable safety buffer for Proxmox hypervisor & I/O cache.`
* **Recovery / Rollback:**
  `host-tuning.sh` is 100% read-only. No rollback is required.

---

### Step A.2: Manual ZFS ARC Adjustment (Optional — Only If ZFS is Active)
If `host-tuning.sh` reports that ZFS is active and ARC is allowed to dynamically consume up to 50% of host RAM (~8.0 GB), you may choose to manually constrain ARC to 1.0 GB to protect host headroom.

* **Action (Manual Decision by Owner):**
  ```bash
  # 1. Apply 1.0 GB ceiling to running kernel (1073741824 bytes = 1.0 GB):
  echo 1073741824 > /sys/module/zfs/parameters/zfs_arc_max

  # 2. Persist across host reboots:
  echo "options zfs zfs_arc_max=1073741824" > /etc/modprobe.d/zfs.conf

  # 3. Refresh initramfs:
  update-initramfs -u -k all
  ```
* **Verification Command:**
  ```bash
  cat /sys/module/zfs/parameters/zfs_arc_max
  ```
  *Expected Output:* `1073741824`
* **Recovery / Rollback Procedure:**
  To revert ZFS ARC to Proxmox dynamic defaults:
  ```bash
  rm -f /etc/modprobe.d/zfs.conf
  echo 0 > /sys/module/zfs/parameters/zfs_arc_max
  update-initramfs -u -k all
  ```

> [!NOTE]
> If your Proxmox host uses `LVM-thin` or `ext4`, skip Step A.2 completely.

---

### Step A.3: Provision VM 100 (Home Assistant OS)

| Parameter | Value | Notes |
| :--- | :--- | :--- |
| **VM ID** | `100` | Standard ID |
| **Processors** | `2 vCPUs` | **Type: `host`** |
| **Memory** | `3072 MB` (3.0 GB) | **Ballooning: Disabled** (Fixed baseline) |
| **Storage** | `32 GB` | Bus: `VirtIO SCSI Single`, Discard enabled, SSD emulation |
| **BIOS / Machine** | `OVMF (UEFI)` / `q35` | Required for HAOS |
| **Network** | Bridge: `vmbr0` | Model: `VirtIO` |

* **Action (CLI Method on Proxmox Shell):**
  ```bash
  wget https://github.com/home-assistant/operating-system/releases/download/12.4/haos_ova-12.4.qcow2.xz
  unxz haos_ova-12.4.qcow2.xz

  qm create 100 --name "haos-production" --ostype l26 --memory 3072 \
    --cores 2 --cpu host --machine q35 --bios ovmf \
    --net0 virtio,bridge=vmbr0 --efidisk0 local-lvm:0,efitype=4m,pre-enrolled-keys=1 \
    --scsihw virtio-scsi-single

  qm importdisk 100 haos_ova-12.4.qcow2 local-lvm
  qm set 100 --scsi0 local-lvm:vm-100-disk-1,discard=on,ssd=1
  qm set 100 --boot order=scsi0
  qm start 100
  ```
* **Verification Command:**
  ```bash
  qm status 100
  ```
  *Expected Output:* `status: running`
* **Recovery / Rollback Procedure:**
  ```bash
  qm stop 100
  qm destroy 100
  ```

---

### Step A.4: Provision VM 101 (Debian 12 AI VM)

| Parameter | Value | Notes |
| :--- | :--- | :--- |
| **VM ID** | `101` | Standard ID |
| **Processors** | `6 vCPUs` | **Type: `host` (CRITICAL: exposes AVX2 to guest)** |
| **Memory** | `8192 MB` (8.0 GB) | **Ballooning: Disabled** (Starting baseline) |
| **Storage** | `64 GB` | Bus: `VirtIO SCSI Single`, Discard enabled, SSD emulation |
| **Network** | Bridge: `vmbr0` | Model: `VirtIO` |

* **Action:**
  Create VM 101 in the Proxmox Web GUI using the standard Debian 12 minimal (netinst) ISO. Ensure CPU type is explicitly set to **`host`**. Complete the standard Debian minimal installation.
* **Verification Command (Inside Debian VM once booted):**
  ```bash
  grep avx2 /proc/cpuinfo
  free -m
  ```
  *Expected Output:* AVX2 flag present in CPU flags; Total memory reported $\ge 7,800$ MB.
* **Recovery / Rollback Procedure:**
  If CPU type was accidentally left as `kvm64`: shut down VM 101, edit Hardware $\rightarrow$ Processors $\rightarrow$ change Type to `host`, and power on.

---

## Part B: Home Network Configuration (TP-Link Omada Controller)

### Step B.1: Static DHCP Reservations
* **Action (Omada Controller Web UI):**
  1. Navigate to **Clients**.
  2. Locate VM 100 (HAOS) MAC address $\rightarrow$ configure fixed DHCP reservation: `192.168.1.50`.
  3. Locate VM 101 (Debian) MAC address $\rightarrow$ configure fixed DHCP reservation: `192.168.1.51`.
* **Verification Command (from any computer on LAN):**
  ```bash
  ping -c 2 192.168.1.50
  ping -c 2 192.168.1.51
  ```
  *Expected Output:* 0% packet loss.
* **Recovery / Rollback:**
  Revert DHCP reservations to dynamic in the Omada client list.

### Step B.2: Local DNS Record for `neptune.home.arpa`
* **Action (Omada Controller Web UI):**
  1. Navigate to **Settings $\rightarrow$ Wired Networks $\rightarrow$ LAN $\rightarrow$ DNS**.
  2. Add a static Local DNS Record:
     * **Domain:** `neptune.home.arpa`
     * **IP Address:** `192.168.1.51`
* **Verification Command (from client computer on LAN):**
  ```bash
  nslookup neptune.home.arpa
  ```
  *Expected Output:* Resolves address `192.168.1.51`.
* **Recovery / Rollback:**
  Delete or modify the DNS entry in Omada settings.

---

## Part C: Inside Debian 12 AI VM (Commands to Run via SSH as User with `sudo`)

### Step C.1: Transfer Repository & Bootstrap Environment
Log into VM 101 via SSH:

* **Action (Inside Debian VM):**
  ```bash
  sudo mkdir -p /opt/neptune
  sudo chown -R $USER:$USER /opt/neptune
  git clone https://github.com/Spender890/neptune-ai.git /opt/neptune
  cd /opt/neptune

  chmod +x scripts/setup-debian-vm.sh scripts/*.sh scripts/*.py
  sudo ./scripts/setup-debian-vm.sh
  ```
* **Verification Command:**
  ```bash
  sudo docker --version
  sudo docker compose version
  sudo ufw status verbose
  ```
  *Expected Output:* Docker Engine and Docker Compose versions reported; UFW status shows `active` with ports 22, 80, 443 allowed.
* **Recovery / Rollback Procedure:**
  To reset UFW: `sudo ufw disable`. To purge Docker: `sudo apt-get purge -y docker-ce docker-ce-cli containerd.io docker-compose-plugin`.

---

### Step C.2: Configure Environment Variables & Service Credentials
* **Action (Inside Debian VM in `/opt/neptune`):**
  ```bash
  # 1. Base environment configuration
  cp .env.example .env
  nano .env

  # 2. Contacts and telephony credentials setup
  cp config/contacts.json.example config/contacts.json
  # Protect tracked pjsip.conf from accidental credential commits before editing secrets:
  git update-index --skip-worktree asterisk/pjsip.conf
  cp asterisk/pjsip.conf.example asterisk/pjsip.conf
  nano asterisk/pjsip.conf  # Set strong unique passwords for extensions 1001, 1002, 7000
  ```
  Confirm:
  * `HOMEASSISTANT_URL=http://192.168.1.50:8123` (or your Home Assistant IP/URL)
  * `HOMEASSISTANT_TOKEN=...` (Home Assistant Long-Lived Access Token)
  * `TV_ENTITY_ID` and `SPEAKER_ENTITY_ID` match entities in Home Assistant and `config/allowed_entities.json`
  * Optional: set `NEPTUNE_API_KEY` if your LAN is shared or untrusted
* **Verification Command:**
  ```bash
  test -f .env && test -f config/contacts.json && test -f asterisk/pjsip.conf && sudo docker compose config -q && echo "Configuration files validated successfully"
  ```
* **Recovery / Rollback:**
  Delete or re-copy files from their corresponding `.example` templates (`git checkout -- asterisk/pjsip.conf` to restore template defaults).

---

### Step C.3: Build, Launch Docker Stack & Pull LLM Weights
* **Action (Inside Debian VM in `/opt/neptune`):**
  ```bash
  sudo docker compose build
  sudo docker compose up -d
  # First-run model download (matches LLM_MODEL in .env):
  sudo docker compose exec ollama ollama pull qwen2.5:3b
  ```
* **Verification Command:**
  ```bash
  sudo docker compose ps
  curl -fsS http://127.0.0.1:3000/api/health
  ```
  *Expected Output:* All six services (`neptune-caddy`, `neptune-backend`, `neptune-ollama`, `neptune-whisper`, `neptune-piper`, `neptune-asterisk`) report status `Up` / `healthy`, and `/api/health` returns `"version": "0.1.0"`.
* **Recovery / Rollback Procedure:**
  ```bash
  sudo docker compose down
  ```

---

### Step C.4: Execute Acceptance Verification Suite
* **Action (Inside Debian VM in `/opt/neptune`):**
  ```bash
  chmod +x scripts/verify-phase1.sh
  ./scripts/verify-phase1.sh
  ```
* **Verification:**
  Script executes tests 1 through 6 and outputs:
  `PHASE 1 ACCEPTANCE CRITERIA MET SUCCESSFULLY.`
* **Recovery / Rollback:**
  If a service fails, inspect its logs: `sudo docker compose logs -f <service-name>`.

---

## Part D: Client Device Setup (Trusting Local TLS Certificate)

Because mobile browsers (iOS Safari, Android Chrome) strictly require a Secure Context (`https://`) to enable `navigator.mediaDevices.getUserMedia` for Push-to-Talk, trust Caddy's internal Root Certificate once on each client device.

> [!IMPORTANT]
> Access MUST occur via **`https://neptune.home.arpa`**. Accessing via direct IP (`https://192.168.1.51`) will fail with a certificate domain mismatch error.

### D.1. Extract Root Certificate
Inside the Debian VM:
```bash
sudo docker cp neptune-caddy:/data/caddy/pki/authorities/local/root.crt ~/neptune-root.crt
```

### D.2. For iOS Devices (iPhone & iPad):
1. Send `neptune-root.crt` to your device (via AirDrop, email, or local download).
2. Tap the file on iOS $\rightarrow$ **Profile Downloaded**.
3. Open **Settings** $\rightarrow$ **Profile Downloaded** $\rightarrow$ tap **Install**.
4. Navigate to **Settings** $\rightarrow$ **General** $\rightarrow$ **About** $\rightarrow$ **Certificate Trust Settings** (bottom of menu).
5. Under *"Enable Full Trust for Root Certificates"*, toggle ON **Caddy Local Authority**.
6. Open Safari and navigate to `https://neptune.home.arpa`. The page will load over trusted HTTPS with zero security warnings, and Push-to-Talk microphone access will be permitted.
* **Rollback:** Settings $\rightarrow$ General $\rightarrow$ VPN & Device Management $\rightarrow$ Select Profile $\rightarrow$ Remove Profile.

### D.3. For Android Devices:
1. Copy `neptune-root.crt` to your device storage.
2. Open **Settings** $\rightarrow$ **Security & Privacy** $\rightarrow$ **More Security Settings** $\rightarrow$ **Encryption & Credentials**.
3. Tap **Install a certificate** $\rightarrow$ **CA Certificate**.
4. Select `neptune-root.crt` and confirm.
5. In Chrome, navigate to `https://neptune.home.arpa`. Wait for TLS trust verification.
* **Rollback:** Settings $\rightarrow$ Security $\rightarrow$ Encryption & Credentials $\rightarrow$ User Credentials $\rightarrow$ Remove Certificate.

---

## Part E: Upgrade, Backup & Recovery Procedures

### Backup (Run Before Any Upgrade)
```bash
cd /opt/neptune
mkdir -p ~/neptune-backups
tar -czf ~/neptune-backups/neptune-backup-$(date +%F).tar.gz \
  .env \
  config/allowed_entities.json \
  config/contacts.json \
  asterisk/pjsip.conf \
  data/
```
Back up Caddy's internal PKI volume if you want existing mobile root certificates to remain trusted across container rebuilds:
```bash
sudo docker cp neptune-caddy:/data/caddy ~/neptune-backups/caddy-pki-$(date +%F)
```

### Standard Upgrade
```bash
cd /opt/neptune
git fetch origin
git pull --rebase
sudo docker compose build
sudo docker compose up -d
```

### Recovery
1. Stop containers: `sudo docker compose down`.
2. Restore backed-up `.env`, `config/`, `asterisk/pjsip.conf`, and `data/reminders.json`.
3. Rebuild previous tagged commit: `git checkout v0.1.0 && sudo docker compose up -d --build`.

---

## Part F: Verification Scope & Environment Matrix (`v0.1.0`)

To maintain strict transparency prior to public release, note what was **verified locally** in this audit versus what **requires live Linux/Docker/LAN hardware**:

| Verification Check | Status in `v0.1.0` Audit | Environment / Notes |
| :--- | :--- | :--- |
| TypeScript unit & mock HTTP integration tests (`15` tests / `8` suites) | **Verified Pass** | Node `v26.13.0` (`playwright/driver/node.exe --import ./backend/test/ts-loader.mjs --test`) |
| Python Wyoming/AGI & repo security invariant tests (`13` tests) | **Verified Pass** | Python `3.15.1` (`python -m unittest discover -s tests -v`) |
| FastPath CPU microbenchmark (`10,000` iterations) | **Verified Pass** | Synthetic local CPU measurement only (`scripts/benchmark-fastpath.ts`) |
| Python byte-compilation & JSON config validation | **Verified Pass** | All Python scripts and 5 JSON files parse cleanly |
| `tsc --noEmit` & `npm install` (`fastify` resolution) | **Not Run Locally** | `npm` / `tsc` unavailable on Windows host; automated in `.github/workflows/ci.yml` |
| `docker compose build` / `up -d` (6 services) | **Not Run Locally** | Docker Engine not present on Windows host; image builds configured in `ci.yml` |
| Live HAOS, LG webOS TV, Jellyfin, Ollama, Whisper, Piper, SIP Extension `7000` | **Not Run Locally** | Requires target Proxmox/Debian/LAN appliances and physical devices |
