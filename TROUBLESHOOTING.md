# NEPTUNE-AI — Diagnostics & Troubleshooting Guide

This guide provides targeted remediation procedures for common failure states across Proxmox host resources, container services, network connectivity, and browser security contexts.

---

## 1. Host Resource & Performance Issues

### Symptom: Proxmox Host Reports High Memory Pressure
* **Context:** The 3.0 GB (HAOS) + 8.0 GB (Debian) allocation is a baseline starting configuration. Under certain workloads (e.g. active ZFS ARC or backup jobs), memory pressure may fluctuate.
* **Diagnostics (Proxmox Shell):**
  ```bash
  free -h
  arcstat 2>/dev/null || cat /proc/spl/kstat/zfs/arcstats
  ```
* **Remediation:**
  1. Inspect ZFS ARC size if ZFS is active. If ARC has grown to several gigabytes, manually constrain it to 1.0 GB:
     ```bash
     echo 1073741824 > /sys/module/zfs/parameters/zfs_arc_max
     echo "options zfs zfs_arc_max=1073741824" > /etc/modprobe.d/zfs.conf
     update-initramfs -u -k all
     ```
  2. Verify that memory ballooning remains **disabled** on both VM 100 and VM 101.

---

### Symptom: Whisper or Piper Inference is Exceptionally Slow or Throws `Illegal Instruction`
* **Root Cause:** Proxmox guest CPU is virtualized as `kvm64` or `qemu64` instead of passing through physical host CPU flags (AVX2).
* **Diagnostics (Debian VM):**
  ```bash
  grep avx2 /proc/cpuinfo
  ```
* **Remediation:**
  1. Shut down VM 101: `sudo shutdown -h now`
  2. In Proxmox Web GUI: **VM 101** $\rightarrow$ **Hardware** $\rightarrow$ **Processors** $\rightarrow$ **Edit**.
  3. Change **Type** from `kvm64` to **`host`**.
  4. Start VM 101 and re-run `./scripts/verify-phase1.sh`.

---

## 2. Browser, DNS & Voice Subsystem Issues

### Symptom: SSL Warning `NET::ERR_CERT_COMMON_NAME_INVALID` in Browser
* **Root Cause:** You navigated to the direct IP (e.g. `https://192.168.1.51`) instead of the configured domain name.
* **Explanation:** Caddy issues the internal TLS certificate specifically for the domain **`neptune.home.arpa`**. It does not cover raw IP addresses.
* **Remediation:**
  1. Navigate to **`https://neptune.home.arpa`**.
  2. If the domain does not resolve, check the Local DNS Record on your Omada router.

---

### Symptom: Domain `neptune.home.arpa` Does Not Resolve
* **Root Cause:** Omada Router Local DNS Record has not been created or client is querying an external DNS server (e.g. 8.8.8.8) or has "Private DNS" enabled on Android.
* **Diagnostics:**
  ```bash
  nslookup neptune.home.arpa
  ```
* **Remediation:**
  1. Verify the client device is connected to the local home Wi-Fi and obtaining DNS from the Omada router (usually `192.168.1.1`).
  2. In Omada Controller, verify **Settings $\rightarrow$ Wired Networks $\rightarrow$ LAN $\rightarrow$ DNS** has a record for `neptune.home.arpa` pointing to `192.168.1.51`.
  3. On Android: Check **Settings $\rightarrow$ Network $\rightarrow$ Private DNS**; set to "Off" or "Automatic" so local LAN DNS is queried.

---

### Symptom: Microphone Button Throws `NotAllowedError` or Permission Denied on Mobile
* **Root Cause:** Accessing over plain HTTP or the self-signed TLS root certificate is untrusted.
* **Remediation:**
  1. Ensure you are accessing via `https://neptune.home.arpa`.
  2. Follow Section Part D of [INSTALLATION.md](file:///INSTALLATION.md) to install `neptune-root.crt` on your mobile device.
  3. On iOS, verify that full trust is enabled in **Settings $\rightarrow$ General $\rightarrow$ About $\rightarrow$ Certificate Trust Settings**.

---

### Symptom: Audio Recording Transcribes as Gibberish or Fails
* **Root Cause:** Ingestion FFmpeg conversion failed or browser sent an unsupported format.
* **Diagnostics:**
  ```bash
  sudo docker compose logs -f neptune-backend
  ```
* **Remediation:**
  * Verify `ffmpeg` is active inside the backend container: `sudo docker compose exec neptune-backend ffmpeg -version`.

---

## 3. Container & Service Diagnostics

### How to Inspect Container Health
```bash
# In /opt/neptune on Debian AI VM:
sudo docker compose ps

# Check logs for a specific service:
sudo docker compose logs -f caddy
sudo docker compose logs -f ollama
sudo docker compose logs -f whisper
sudo docker compose logs -f piper
sudo docker compose logs -f neptune-backend
```

### Symptom: Port 80 or 443 Binding Failure on Caddy Startup
* **Root Cause:** Another service (e.g. Apache, Nginx) is already listening on port 80 or 443.
* **Diagnostics:**
  ```bash
  sudo ss -tulpn | grep -E ':(80|443)'
  ```
* **Remediation:**
  * Disable and stop conflicting services:
    ```bash
    sudo systemctl stop nginx apache2 2>/dev/null || true
    sudo systemctl disable nginx apache2 2>/dev/null || true
    ```
  * Restart the Docker stack:
    ```bash
    sudo docker compose up -d caddy
    ```

---

## 4. Local Integration & Network Connectivity

### Symptom: Backend Cannot Connect to Home Assistant
* **Diagnostics:**
  ```bash
  curl -I http://192.168.1.50:8123
  ```
* **Remediation:**
  1. Confirm VM 100 has booted and obtained an IP on `vmbr0`.
  2. Check if Home Assistant has banned the IP address under `ip_bans.yaml`.
  3. Verify the `HOMEASSISTANT_TOKEN` in `.env` has not expired or been revoked.

### Symptom: Jellyfin Media Search Returns Empty or Fails
* **Diagnostics:**
  ```bash
  curl -s "http://192.168.1.60:8096/System/Info/Public" | jq .
  ```
* **Remediation:**
  1. Confirm the WD Sentinel server is powered on and accessible.
  2. Verify that `JELLYFIN_API_KEY` was generated from Jellyfin Dashboard $\rightarrow$ Advanced $\rightarrow$ API Keys.
  3. Verify that Music Assistant inside Home Assistant has connected to Jellyfin successfully.
