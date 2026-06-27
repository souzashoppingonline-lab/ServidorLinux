#!/bin/bash
# Linux Security Monitor - System Audit Module

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

MODULE="AUDIT"

# ============================================================
# SYSTEM AUDIT REPORT
# ============================================================
run_full_audit() {
    log_info "Starting full system audit" "${MODULE}"

    local report_file="${LSM_DATA_DIR}/reports/audit_$(date +%Y%m%d_%H%M%S).txt"
    mkdir -p "$(dirname "${report_file}")"

    {
        echo "=================================================="
        echo " Linux Security Monitor - Full System Audit"
        echo " Date: $(date)"
        echo " Host: $(get_hostname)"
        echo "=================================================="
        echo ""

        audit_system_info
        audit_users_and_groups
        audit_ssh_config
        audit_services
        audit_cron_jobs
        audit_filesystem_permissions
        audit_kernel_parameters
        audit_installed_packages
        audit_open_ports
        audit_firewall
        audit_logs

        echo ""
        echo "=================================================="
        echo " Audit Complete"
        echo "=================================================="
    } | tee "${report_file}"

    log_info "Audit report saved: ${report_file}" "${MODULE}"
    echo ""
    echo "Report saved to: ${report_file}"
}

# ============================================================
# AUDIT SECTIONS
# ============================================================
audit_system_info() {
    echo ""
    echo "=== SYSTEM INFORMATION ==="
    echo "OS: $(get_os_info)"
    echo "Kernel: $(get_kernel)"
    echo "Uptime: $(uptime -p 2>/dev/null || uptime)"
    echo "CPU cores: $(nproc)"
    echo "Total RAM: $(free -h | grep Mem | awk '{print $2}')"
    echo "Disk usage: $(df -h / | tail -1)"

    # Check for pending updates
    if command_exists apt; then
        local updates
        updates=$(apt list --upgradable 2>/dev/null | grep -c upgradable || echo 0)
        echo "Pending updates: ${updates}"
        if [[ ${updates} -gt 0 ]]; then
            db_insert_event "AUDIT" "PENDING_UPDATES" 2 \
                "${updates} atualizações pendentes" \
                "Execute: apt upgrade" "" "" 5
        fi
    fi

    echo ""
}

audit_users_and_groups() {
    echo "=== USERS AND GROUPS ==="

    # Users with UID 0
    echo ""
    echo "--- Root-equivalent users (UID=0) ---"
    awk -F: '$3==0{print $1}' /etc/passwd

    # Users with login shell
    echo ""
    echo "--- Users with login shell ---"
    awk -F: '$7!~/nologin|false/{print $1":"$3":"$7}' /etc/passwd | grep -v "^#"

    # Sudo users
    echo ""
    echo "--- Sudo/Admin group members ---"
    for group in sudo wheel admin; do
        local members
        members=$(getent group "${group}" 2>/dev/null | cut -d: -f4)
        [[ -n "${members}" ]] && echo "Group ${group}: ${members}"
    done

    # Accounts with empty passwords
    echo ""
    echo "--- Accounts with empty passwords ---"
    awk -F: '($2=="" || $2=="!!" || $2=="*"){print $1}' /etc/shadow 2>/dev/null || echo "Cannot read /etc/shadow"

    # Last logins
    echo ""
    echo "--- Recent logins ---"
    last -n 10 2>/dev/null || echo "N/A"

    echo ""
}

audit_ssh_config() {
    echo "=== SSH CONFIGURATION ==="
    local ssh_config="/etc/ssh/sshd_config"

    if [[ ! -f "${ssh_config}" ]]; then
        echo "SSH config not found"
        return
    fi

    echo ""
    local checks=(
        "PermitRootLogin:should be no"
        "PasswordAuthentication:should be no"
        "PermitEmptyPasswords:should be no"
        "MaxAuthTries:should be <= 3"
        "Protocol:should be 2"
        "X11Forwarding:should be no"
        "AllowTcpForwarding:consider no"
        "ClientAliveInterval:should be set"
        "LoginGraceTime:should be <= 60"
    )

    for check in "${checks[@]}"; do
        local key="${check%%:*}"
        local note="${check##*:}"
        local value
        value=$(grep -iE "^${key}\s+" "${ssh_config}" | awk '{print $2}' | tail -1)
        echo "${key}: ${value:-<not set>} (${note})"
    done

    local port
    port=$(grep -iE "^Port\s+" "${ssh_config}" | awk '{print $2}' | tail -1 || echo "22")
    echo "Port: ${port}"
    [[ "${port}" == "22" ]] && echo "  WARNING: Using default port 22 - consider changing"

    echo ""
}

audit_services() {
    echo "=== RUNNING SERVICES ==="
    echo ""

    if command_exists systemctl; then
        echo "--- Active services ---"
        systemctl list-units --type=service --state=active --no-pager 2>/dev/null | \
            grep -v "^$\|^UNIT\|^Legend" | head -30 || true

        echo ""
        echo "--- Failed services ---"
        systemctl list-units --type=service --state=failed --no-pager 2>/dev/null | \
            grep -v "^$\|^UNIT\|^Legend" || echo "No failed services"
    fi

    echo ""
}

audit_cron_jobs() {
    echo "=== CRON JOBS ==="
    echo ""

    echo "--- /etc/crontab ---"
    [[ -f /etc/crontab ]] && cat /etc/crontab || echo "Not found"

    echo ""
    echo "--- /etc/cron.d/ ---"
    for f in /etc/cron.d/*; do
        [[ -f "${f}" ]] && { echo "File: ${f}"; cat "${f}"; echo ""; }
    done

    echo ""
    echo "--- User crontabs ---"
    for user in $(cut -f1 -d: /etc/passwd); do
        local tab
        tab=$(crontab -l -u "${user}" 2>/dev/null | grep -v "^#\|^$" || true)
        [[ -n "${tab}" ]] && echo "User ${user}: ${tab}"
    done

    echo ""
}

audit_filesystem_permissions() {
    echo "=== FILESYSTEM SECURITY ==="
    echo ""

    echo "--- World-writable files (system paths) ---"
    find /etc /usr /bin /sbin /lib -perm -002 -type f 2>/dev/null | head -20 || echo "None found"

    echo ""
    echo "--- SUID/SGID binaries ---"
    find /bin /sbin /usr/bin /usr/sbin -perm /6000 -type f 2>/dev/null | sort

    echo ""
    echo "--- Unowned files ---"
    find / -nouser -o -nogroup 2>/dev/null | grep -v "^/proc\|^/sys\|^/dev" | head -20 || echo "None found"

    echo ""
}

audit_kernel_parameters() {
    echo "=== KERNEL SECURITY PARAMETERS ==="
    echo ""

    local params=(
        "net.ipv4.conf.all.accept_redirects:0"
        "net.ipv4.conf.all.send_redirects:0"
        "net.ipv4.conf.all.accept_source_route:0"
        "net.ipv4.tcp_syncookies:1"
        "net.ipv4.conf.all.rp_filter:1"
        "net.ipv4.icmp_echo_ignore_broadcasts:1"
        "kernel.randomize_va_space:2"
        "kernel.dmesg_restrict:1"
        "fs.suid_dumpable:0"
        "kernel.exec-shield:1"
    )

    local issues=0
    for param in "${params[@]}"; do
        local key="${param%%:*}"
        local expected="${param##*:}"
        local current
        current=$(sysctl -n "${key}" 2>/dev/null || echo "N/A")

        local status="OK"
        if [[ "${current}" == "N/A" ]]; then
            status="NOT AVAILABLE"
        elif [[ "${current}" != "${expected}" ]]; then
            status="WARNING (expected: ${expected})"
            (( issues++ ))
        fi

        echo "${key} = ${current} [${status}]"
    done

    if [[ ${issues} -gt 0 ]]; then
        db_insert_event "AUDIT" "KERNEL_PARAMS" 2 \
            "${issues} parâmetros de kernel inseguros" \
            "Execute sysctl para corrigir configurações" "" "" 10
    fi

    echo ""
}

audit_installed_packages() {
    echo "=== INSTALLED PACKAGES ==="
    echo ""

    if command_exists apt; then
        echo "--- Package manager: apt ---"
        echo "Installed packages: $(dpkg -l 2>/dev/null | grep -c '^ii' || echo 0)"

        # Check for known vulnerable packages
        echo ""
        echo "--- Security-relevant packages ---"
        for pkg in openssh-server ufw fail2ban apparmor libpam-cracklib unattended-upgrades; do
            local status
            status=$(dpkg -s "${pkg}" 2>/dev/null | grep "^Status:" | awk '{print $NF}' || echo "not installed")
            echo "${pkg}: ${status}"
        done
    fi

    echo ""
}

audit_open_ports() {
    echo "=== OPEN PORTS ==="
    echo ""
    echo "--- Listening TCP ports ---"
    ss -tlnp 2>/dev/null | grep LISTEN

    echo ""
    echo "--- Listening UDP ports ---"
    ss -ulnp 2>/dev/null | grep UNCONN || true

    echo ""
}

audit_firewall() {
    echo "=== FIREWALL STATUS ==="
    echo ""

    if command_exists ufw; then
        echo "--- UFW ---"
        ufw status verbose 2>/dev/null || echo "UFW not responding"
    elif command_exists iptables; then
        echo "--- IPTables ---"
        iptables -L -n 2>/dev/null | head -50
    else
        echo "No firewall tool found"
    fi

    echo ""
}

audit_logs() {
    echo "=== LOG ANALYSIS ==="
    echo ""

    # Recent failed logins
    echo "--- Failed SSH logins (last 24h) ---"
    if [[ -f /var/log/auth.log ]]; then
        local yesterday
        yesterday=$(date -d "yesterday" '+%b %e' 2>/dev/null || date '+%b %e')
        local today
        today=$(date '+%b %e')
        grep -E "Failed password|Invalid user" /var/log/auth.log 2>/dev/null | \
            grep -E "${yesterday}|${today}" | \
            awk '{print $1,$2,$3,$11,$13}' | sort | uniq -c | sort -rn | head -10 || \
            echo "Cannot read auth.log"
    fi

    echo ""
    echo "--- Sudo usage (last 24h) ---"
    if [[ -f /var/log/auth.log ]]; then
        grep "sudo:" /var/log/auth.log 2>/dev/null | tail -20 || echo "N/A"
    fi

    echo ""
}

# ============================================================
# QUICK SECURITY CHECK
# ============================================================
quick_check() {
    local score=0
    local issues=0

    echo ""
    echo "=== Quick Security Score ==="
    echo ""

    # SSH hardening
    if [[ -f /etc/ssh/sshd_config ]]; then
        grep -qiE "^PermitRootLogin\s+no" /etc/ssh/sshd_config && score=$(( score + 10 )) || {
            echo "[-10] SSH: Root login not disabled"
            (( issues++ ))
        }
        grep -qiE "^PasswordAuthentication\s+no" /etc/ssh/sshd_config && score=$(( score + 10 )) || {
            echo "[-10] SSH: Password auth enabled"
        }
    fi

    # Firewall
    if command_exists ufw; then
        ufw status 2>/dev/null | grep -q "Status: active" && score=$(( score + 15 )) || {
            echo "[-15] FIREWALL: UFW is not active"
            (( issues++ ))
        }
    fi

    # Fail2ban
    command_exists fail2ban-client && score=$(( score + 10 )) || {
        echo "[-10] FAIL2BAN: Not installed"
    }

    # Unattended upgrades
    if [[ -f /etc/apt/apt.conf.d/20auto-upgrades ]]; then
        grep -q "1" /etc/apt/apt.conf.d/20auto-upgrades && score=$(( score + 10 )) || {
            echo "[-10] UPDATES: Auto-updates not configured"
        }
    else
        echo "[-10] UPDATES: Auto-updates not configured"
    fi

    # AppArmor/SELinux
    if command_exists aa-status; then
        aa-status 2>/dev/null | grep -q "profiles are in enforce mode" && score=$(( score + 10 )) || {
            echo "[-10] APPARMOR: Not in enforce mode"
        }
    fi

    # No world-writable system files
    local ww_count
    ww_count=$(find /etc -perm -002 -type f 2>/dev/null | wc -l)
    [[ ${ww_count} -eq 0 ]] && score=$(( score + 15 )) || {
        echo "[-15] FILESYSTEM: ${ww_count} world-writable files in /etc"
        (( issues++ ))
    }

    # Kernel parameters
    local syncookies
    syncookies=$(sysctl -n net.ipv4.tcp_syncookies 2>/dev/null || echo 0)
    [[ "${syncookies}" == "1" ]] && score=$(( score + 10 )) || {
        echo "[-10] KERNEL: TCP SYN cookies not enabled"
    }

    echo ""
    echo "Security Score: ${score}/80"
    echo "Issues found: ${issues}"

    db_insert_metric "security_score" "${score}" "points" ""
    db_insert_event "AUDIT" "QUICK_CHECK" 1 "Quick security check: score ${score}/80" \
        "${issues} issues found" "" "" 0
}

# ============================================================
# MAIN
# ============================================================
main() {
    lsm_init

    case "${1:-quick}" in
        full)
            run_full_audit
            ;;
        quick|check)
            quick_check
            ;;
        users)
            audit_users_and_groups
            ;;
        ssh)
            audit_ssh_config
            ;;
        services)
            audit_services
            ;;
        ports)
            audit_open_ports
            ;;
        kernel)
            audit_kernel_parameters
            ;;
        firewall)
            audit_firewall
            ;;
        *)
            echo "Usage: ${0} {full|quick|users|ssh|services|ports|kernel|firewall}"
            exit 1
            ;;
    esac
}

main "${@}"
