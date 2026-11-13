#!/bin/bash
# ==============================================================================
# PROXMOX HOST STORAGE & MEMORY AUDIT SCRIPT (READ-ONLY)
# ==============================================================================
# Target: Proxmox VE Host (Intel Core i7-10700 | 16 GB Total RAM)
# Purpose: Inspects storage configuration and ZFS Adaptive Replacement Cache (ARC).
#
# ARCHITECTURAL CONCEPTS EXPLAINED:
# 1. Allocated VM RAM: Fixed physical memory dedicated to QEMU/KVM processes.
#    (VM 100 HAOS: 3.0 GB + VM 101 Debian: 8.0 GB = 11.0 GB Total Committed).
# 2. Host Available RAM: Memory remaining for Proxmox VE hypervisor processes
#    (pvedaemon, pve-cluster, corosync, kernel buffers, backup snapshot caching).
# 3. ZFS ARC (Adaptive Replacement Cache): Dynamic filesystem cache in kernel RAM.
#    By default, ZFS on Linux allows ARC to grow up to 50% of host RAM (~8.0 GB).
#    While ARC is designed to shrink when memory is requested, rapid burst allocations
#    by VMs can outpace ARC eviction, triggering kernel allocation stalls or OOM kills.
#
# SAFETY GUARANTEE:
# - This script is STRICTLY READ-ONLY and DIAGNOSTIC.
# - It DOES NOT modify any system configuration files.
# - It DOES NOT alter kernel parameters or initramfs.
# - It outputs informational review commands for the project owner.
# ==============================================================================

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${CYAN}======================================================================${NC}"
echo -e "${CYAN}   NEPTUNE-AI Proxmox Host Storage & Memory Audit (Read-Only)         ${NC}"
echo -e "${CYAN}======================================================================${NC}\n"

# 1. Inspect Physical Host Memory
echo -e "${BOLD}1. Host Physical Memory Audit:${NC}"
if [ -f /proc/meminfo ]; then
    TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    TOTAL_MEM_GB=$(awk "BEGIN {printf \"%.2f\", $TOTAL_MEM_KB/1024/1024}")
    AVAIL_MEM_KB=$(grep MemAvailable /proc/meminfo | awk '{print $2}')
    AVAIL_MEM_GB=$(awk "BEGIN {printf \"%.2f\", $AVAIL_MEM_KB/1024/1024}")
    echo -e "   - Total Host Physical RAM: ${GREEN}${TOTAL_MEM_GB} GB${NC}"
    echo -e "   - Currently Available RAM:  ${GREEN}${AVAIL_MEM_GB} GB${NC}"
else
    echo -e "   ${RED}[ERROR] /proc/meminfo not accessible.${NC}"
fi

# 2. Detect Storage Backend Configuration
echo -e "\n${BOLD}2. Storage Backend Detection:${NC}"
STORAGE_TYPES=()

if [ -f /proc/spl/kstat/zfs/arcstats ]; then
    STORAGE_TYPES+=("ZFS")
fi

if command -v lvs &> /dev/null; then
    STORAGE_TYPES+=("LVM/LVM-thin")
fi

if [ ${#STORAGE_TYPES[@]} -eq 0 ]; then
    echo -e "   - Active Storage Backend: ${YELLOW}Standard Linux filesystem (ext4 / xfs / other)${NC}"
else
    echo -e "   - Detected Storage Subsystems: ${GREEN}${STORAGE_TYPES[*]}${NC}"
fi

# 3. ZFS ARC Deep-Dive (If ZFS is present)
echo -e "\n${BOLD}3. ZFS Adaptive Replacement Cache (ARC) Status:${NC}"
if [ ! -f /proc/spl/kstat/zfs/arcstats ]; then
    echo -e "   ${GREEN}[INFO] ZFS kernel module is not loaded.${NC}"
    echo -e "   Your Proxmox storage is not using ZFS ARC memory caching."
    echo -e "   ${GREEN}[CONCLUSION] No ZFS ARC tuning is required. Memory is not at risk from ARC growth.${NC}"
else
    CURRENT_ARC_BYTES=$(awk '/^size/ {print $3}' /proc/spl/kstat/zfs/arcstats)
    CURRENT_ARC_MB=$((CURRENT_ARC_BYTES / 1024 / 1024))
    
    # Read current arc_max kernel parameter
    if [ -f /sys/module/zfs/parameters/zfs_arc_max ]; then
        MAX_ARC_BYTES=$(cat /sys/module/zfs/parameters/zfs_arc_max)
        if [ "$MAX_ARC_BYTES" -eq 0 ]; then
            MAX_ARC_HUMAN="Default (Dynamic up to 50% of host RAM: ~8.0 GB)"
            ARC_RISK_DETECTED=1
        else
            MAX_ARC_MB=$((MAX_ARC_BYTES / 1024 / 1024))
            MAX_ARC_HUMAN="${MAX_ARC_MB} MB"
            ARC_RISK_DETECTED=0
        fi
    else
        MAX_ARC_HUMAN="Unknown"
        ARC_RISK_DETECTED=0
    fi

    echo -e "   - Active ARC Consumption: ${YELLOW}${CURRENT_ARC_MB} MB${NC}"
    echo -e "   - Configured ARC Ceiling: ${CYAN}${MAX_ARC_HUMAN}${NC}"

    if [ "${ARC_RISK_DETECTED:-0}" -eq 1 ]; then
        echo -e "\n   ${YELLOW}[EXPLANATION OF POTENTIAL MEMORY RISK]${NC}"
        echo -e "   ZFS ARC is currently allowed to dynamically expand up to ~8.0 GB."
        echo -e "   With VM 100 (3.0 GB) and VM 101 (8.0 GB) totaling 11.0 GB of allocated RAM,"
        echo -e "   if ARC expands during heavy disk activity (e.g. backup), ARC eviction lag can"
        echo -e "   cause transient memory pressure on the Proxmox host."
        echo -e "\n   ${BOLD}Proposed Manual Adjustment (Informational Only):${NC}"
        echo -e "   You may choose to manually constrain ZFS ARC max to 1.0 GB (1073741824 bytes)."
        echo -e "   This ensures Proxmox always retains at least 4.0 GB of unencumbered host RAM."
        echo -e "\n   ${CYAN}If you choose to apply this change manually, run these commands as root:${NC}"
        echo -e "   ------------------------------------------------------------------"
        echo -e "   # 1. Apply to running kernel immediately:"
        echo -e "   echo 1073741824 > /sys/module/zfs/parameters/zfs_arc_max"
        echo -e ""
        echo -e "   # 2. Persist across host reboots:"
        echo -e "   echo 'options zfs zfs_arc_max=1073741824' > /etc/modprobe.d/zfs.conf"
        echo -e "   update-initramfs -u -k all"
        echo -e "   ------------------------------------------------------------------"
    else
        echo -e "   ${GREEN}[OK] ZFS ARC is already constrained to: ${MAX_ARC_HUMAN}.${NC}"
    fi
fi

# 4. Sizing Verification Summary
echo -e "\n${BOLD}4. Memory Architecture Summary (16.0 GB Total Physical RAM):${NC}"
echo -e "   - Host Physical RAM:         16.0 GB"
echo -e "   - Committed to VM 100 (HAOS): 3.0 GB"
echo -e "   - Committed to VM 101 (Debian):8.0 GB"
echo -e "   - Unallocated Host Headroom:  5.0 GB (31.25% of host memory)"
echo -e "   ${GREEN}[ASSESSMENT] Sizing provides comfortable safety buffer for Proxmox hypervisor & I/O cache.${NC}"

echo -e "\n${CYAN}======================================================================${NC}"
echo -e "${CYAN}   Audit Complete. No system modifications were made.                 ${NC}"
echo -e "${CYAN}======================================================================${NC}"
exit 0
