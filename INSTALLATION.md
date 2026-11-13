# NEPTUNE-AI — Infrastructure & Phase 1 Deployment Guide

This guide provides an ordered, verifiable manual installation procedure for Neptune-AI Phase 1.

### Target Architecture Overview
* **VM 100:** Home Assistant OS (HAOS) on Proxmox VE (3.0 GB RAM, 2 vCPUs).
* **VM 101:** Debian 12 minimal on Proxmox VE (8.0 GB RAM, 6 vCPUs).
* **WD Sentinel DX4000:** Standalone server running Debian 12 and Jellyfin (`192.168.1.60`) — **Remains completely untouched**.
* **Zero Host Modifications:** No disks formatted, no storage modified, and no automatic ZFS changes executed.

---

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
  cd /opt/neptune

  # Copy repository files here, then execute:
  chmod +x scripts/setup-debian-vm.sh
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

### Step C.2: Configure Environment Variables
* **Action (Inside Debian VM in `/opt/neptune`):**
  ```bash
  cp .env.example .env
  nano .env
  ```
  Confirm:
  * `HOMEASSISTANT_URL=http://192.168.1.50:8123`
  * `JELLYFIN_URL=http://192.168.1.60:8096`
  * `NEPTUNE_DOMAIN=neptune.home.arpa`
* **Verification Command:**
  ```bash
  test -f .env && echo ".env created successfully"
  ```
* **Recovery / Rollback:**
  Delete or re-copy `.env` from `.env.example`.

---

### Step C.3: Build & Launch Docker Stack
* **Action (Inside Debian VM in `/opt/neptune`):**
  ```bash
  sudo docker compose build
  sudo docker compose up -d
  ```
* **Verification Command:**
  ```bash
  sudo docker compose ps
  ```
  *Expected Output:* All five services (`neptune-caddy`, `neptune-backend`, `neptune-ollama`, `neptune-whisper`, `neptune-piper`) report status `Up` (healthy).
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
5. In Chrome, navigate to `https://neptune.home.arpa`. Full microphone access is now unlocked.
* **Rollback:** Settings $\rightarrow$ Security $\rightarrow$ Encryption & Credentials $\rightarrow$ User Credentials $\rightarrow$ Remove Certificate.
