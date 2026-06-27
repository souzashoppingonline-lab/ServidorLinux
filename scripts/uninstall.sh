#!/bin/bash
# Linux Security Monitor - Uninstall Script

set -e

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

[[ $EUID -ne 0 ]] && { echo -e "${RED}Must run as root${NC}"; exit 1; }

echo -e "${YELLOW}"
echo "======================================"
echo "  Linux Security Monitor Uninstaller"
echo "======================================"
echo -e "${NC}"
echo ""
read -rp "Are you sure you want to uninstall LSM? This will delete ALL data. [y/N]: " confirm
[[ "${confirm}" != "y" && "${confirm}" != "Y" ]] && { echo "Aborted."; exit 0; }

read -rp "Keep log files and database? [Y/n]: " keep_data
keep_data="${keep_data:-Y}"

echo ""
echo "Stopping services..."
systemctl stop lsm-monitor lsm-scheduler lsm-web 2>/dev/null || true
systemctl disable lsm-monitor lsm-scheduler lsm-web 2>/dev/null || true

echo "Removing systemd units..."
rm -f /etc/systemd/system/lsm-monitor.service
rm -f /etc/systemd/system/lsm-scheduler.service
rm -f /etc/systemd/system/lsm-web.service
rm -f /etc/systemd/system/lsm.target
systemctl daemon-reload

echo "Removing CLI tool..."
rm -f /usr/local/bin/lsm

echo "Removing logrotate config..."
rm -f /etc/logrotate.d/lsm

echo "Removing fail2ban config..."
rm -f /etc/fail2ban/jail.d/lsm.conf
systemctl restart fail2ban 2>/dev/null || true

echo "Removing installation directory..."
rm -rf /opt/linux-security-monitor

if [[ "${keep_data}" == "n" || "${keep_data}" == "N" ]]; then
    echo "Removing data and logs..."
    rm -rf /var/lib/lsm
    rm -rf /var/log/lsm
    rm -rf /var/run/lsm
fi

echo "Removing system user..."
userdel lsm 2>/dev/null || true

echo ""
echo -e "${GREEN}Linux Security Monitor has been uninstalled.${NC}"
if [[ "${keep_data}" != "n" && "${keep_data}" != "N" ]]; then
    echo "Data preserved in /var/lib/lsm and /var/log/lsm"
fi
