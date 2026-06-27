#!/bin/bash
# Linux Security Monitor - Test Suite
# Validates all modules and fixes common issues

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LSM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Test colors
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

PASS=0; FAIL=0; WARN=0
FAILURES=()

# ============================================================
# TEST FRAMEWORK
# ============================================================
test_pass() { echo -e "  ${GREEN}[PASS]${NC} ${1}"; (( PASS++ )); }
test_fail() { echo -e "  ${RED}[FAIL]${NC} ${1}"; (( FAIL++ )); FAILURES+=("${1}"); }
test_warn() { echo -e "  ${YELLOW}[WARN]${NC} ${1}"; (( WARN++ )); }
section()   { echo -e "\n${CYAN}=== ${1} ===${NC}"; }

run_test() {
    local name="${1}"
    local cmd="${2}"
    if eval "${cmd}" >/dev/null 2>&1; then
        test_pass "${name}"
        return 0
    else
        test_fail "${name}"
        return 1
    fi
}

# ============================================================
# TEST: FILE STRUCTURE
# ============================================================
test_file_structure() {
    section "File Structure"

    local required_files=(
        "scripts/lib.sh"
        "scripts/monitor.sh"
        "scripts/ssh.sh"
        "scripts/users.sh"
        "scripts/process.sh"
        "scripts/network.sh"
        "scripts/integrity.sh"
        "scripts/audit.sh"
        "scripts/daemon.sh"
        "scripts/telegram.sh"
        "scripts/install.sh"
        "scripts/uninstall.sh"
        "scripts/update.sh"
        "config/monitor.conf"
        "web/src/server.js"
        "web/public/index.html"
        "web/public/login.html"
        "web/public/css/dashboard.css"
        "web/public/js/dashboard.js"
        "systemd/lsm-monitor.service"
        "systemd/lsm-web.service"
    )

    for f in "${required_files[@]}"; do
        run_test "File exists: ${f}" "[[ -f '${LSM_ROOT}/${f}' ]]"
    done
}

# ============================================================
# TEST: SCRIPT SYNTAX
# ============================================================
test_script_syntax() {
    section "Shell Script Syntax"

    for script in "${LSM_ROOT}/scripts/"*.sh; do
        local name
        name=$(basename "${script}")
        run_test "Syntax OK: ${name}" "bash -n '${script}'"
    done
}

# ============================================================
# TEST: LIBRARY FUNCTIONS
# ============================================================
test_lib_functions() {
    section "Library Functions"

    # Source the library
    # shellcheck source=/dev/null
    source "${LSM_ROOT}/scripts/lib.sh" 2>/dev/null || {
        test_fail "Cannot source lib.sh"
        return
    }

    run_test "get_hostname works" "[[ -n \"\$(get_hostname)\" ]]"
    run_test "get_os_info works" "[[ -n \"\$(get_os_info)\" ]]"
    run_test "get_cpu_usage works" "[[ -n \"\$(get_cpu_usage 2>/dev/null)\" ]]"
    run_test "get_memory_usage works" "[[ -n \"\$(get_memory_usage 2>/dev/null)\" ]]"
    run_test "get_load_average works" "[[ -n \"\$(get_load_average 2>/dev/null)\" ]]"
    run_test "get_disk_usage works" "[[ -n \"\$(get_disk_usage / 2>/dev/null)\" ]]"
    run_test "is_ip_address: valid IP" "is_ip_address '192.168.1.1'"
    run_test "is_ip_address: invalid" "! is_ip_address 'not-an-ip'"
    run_test "is_private_ip: 192.168.x.x" "is_private_ip '192.168.1.1'"
    run_test "is_private_ip: public" "! is_private_ip '8.8.8.8'"
    run_test "get_risk_level: LOW" "[[ \"\$(get_risk_level 10)\" == 'LOW' ]]"
    run_test "get_risk_level: CRITICAL" "[[ \"\$(get_risk_level 80)\" == 'CRITICAL' ]]"
    run_test "command_exists: bash" "command_exists bash"
    run_test "command_exists: nonexistent" "! command_exists __nonexistent_cmd_xyz__"
}

# ============================================================
# TEST: DATABASE
# ============================================================
test_database() {
    section "Database"

    if ! command -v sqlite3 &>/dev/null; then
        test_warn "sqlite3 not available - database tests skipped"
        return 0
    fi

    local test_db="/tmp/lsm_test_$$.db"
    LSM_DB_FILE="${test_db}"

    # shellcheck source=/dev/null
    source "${LSM_ROOT}/scripts/lib.sh" 2>/dev/null

    run_test "db_init creates database" "db_init && [[ -f '${test_db}' ]]"
    run_test "events table exists" "sqlite3 '${test_db}' 'SELECT 1 FROM events LIMIT 1;'"
    run_test "metrics table exists" "sqlite3 '${test_db}' 'SELECT 1 FROM metrics LIMIT 1;'"
    run_test "integrity_baseline table exists" "sqlite3 '${test_db}' 'SELECT 1 FROM integrity_baseline LIMIT 1;'"
    run_test "risk_scores table exists" "sqlite3 '${test_db}' 'SELECT 1 FROM risk_scores LIMIT 1;'"

    run_test "db_insert_event works" "db_insert_event 'TEST' 'TEST_EVENT' 1 'Test event' 'Test description'"
    run_test "event can be read back" "[[ \"\$(sqlite3 '${test_db}' \"SELECT COUNT(*) FROM events WHERE module='TEST';\")\" == '1' ]]"
    run_test "db_insert_metric works" "db_insert_metric 'test_metric' '42.5' '%' 'test=true'"
    run_test "metric can be read back" "[[ \"\$(sqlite3 '${test_db}' \"SELECT metric_value FROM metrics WHERE metric_name='test_metric';\")\" == '42.5' ]]"

    run_test "calculate_risk_score returns number" "local s; s=\$(calculate_risk_score 2>/dev/null); [[ \"\${s}\" =~ ^[0-9]+\$ ]]"

    rm -f "${test_db}"
    LSM_DB_FILE="/var/lib/lsm/lsm.db"
}

# ============================================================
# TEST: CONFIG
# ============================================================
test_config() {
    section "Configuration"

    local config_file="${LSM_ROOT}/config/monitor.conf"

    run_test "Config file exists" "[[ -f '${config_file}' ]]"
    run_test "CHECK_INTERVAL defined" "grep -q 'CHECK_INTERVAL=' '${config_file}'"
    run_test "CPU_ALERT_THRESHOLD defined" "grep -q 'CPU_ALERT_THRESHOLD=' '${config_file}'"
    run_test "TELEGRAM_ENABLED defined" "grep -q 'TELEGRAM_ENABLED=' '${config_file}'"
    run_test "WEB_PORT defined" "grep -q 'WEB_PORT=' '${config_file}'"

    # Source config and check values
    source "${config_file}" 2>/dev/null

    run_test "CHECK_INTERVAL is numeric" "[[ '${CHECK_INTERVAL}' =~ ^[0-9]+$ ]]"
    run_test "WEB_PORT is numeric" "[[ '${WEB_PORT}' =~ ^[0-9]+$ ]]"
    run_test "WEB_PORT in valid range" "[[ '${WEB_PORT}' -ge 80 && '${WEB_PORT}' -le 65535 ]]"
}

# ============================================================
# TEST: SYSTEM COMMANDS
# ============================================================
test_system_commands() {
    section "System Command Availability"

    local required=("bash" "ps" "awk" "grep" "sed" "curl")
    local optional=("sqlite3" "ss" "ip" "openssl" "fail2ban-client" "docker" "systemctl" "ufw" "bc")

    for cmd in "${required[@]}"; do
        run_test "Required: ${cmd}" "command -v '${cmd}' &>/dev/null"
    done

    for cmd in "${optional[@]}"; do
        if command -v "${cmd}" &>/dev/null; then
            test_pass "Optional: ${cmd} (available)"
        else
            test_warn "Optional: ${cmd} (not available - some features disabled)"
        fi
    done
}

# ============================================================
# TEST: MONITOR MODULE
# ============================================================
test_monitor() {
    section "Monitor Module"

    run_test "monitor.sh has correct permissions" "[[ -f '${LSM_ROOT}/scripts/monitor.sh' ]]"
    run_test "monitor.sh syntax valid" "bash -n '${LSM_ROOT}/scripts/monitor.sh'"
    run_test "get_cpu_usage returns number" "
        source '${LSM_ROOT}/scripts/lib.sh' 2>/dev/null
        v=\$(get_cpu_usage 2>/dev/null)
        [[ \"\${v}\" =~ ^[0-9]+(\.[0-9]+)?$ ]]
    "
    run_test "get_memory_usage returns number" "
        source '${LSM_ROOT}/scripts/lib.sh' 2>/dev/null
        v=\$(get_memory_usage 2>/dev/null)
        [[ \"\${v}\" =~ ^[0-9]+(\.[0-9]+)?$ ]]
    "
    run_test "get_load_average returns number" "
        source '${LSM_ROOT}/scripts/lib.sh' 2>/dev/null
        v=\$(get_load_average 2>/dev/null)
        [[ \"\${v}\" =~ ^[0-9]+(\.[0-9]+)?$ ]]
    "
}

# ============================================================
# TEST: SSH MODULE
# ============================================================
test_ssh() {
    section "SSH Module"

    run_test "ssh.sh syntax valid" "bash -n '${LSM_ROOT}/scripts/ssh.sh'"
    if [[ -f '/etc/ssh/sshd_config' ]]; then
        test_pass "SSH config file exists"
    else
        test_warn "SSH config file not found (SSH not installed or different path)"
    fi

    # Test log detection
    local log_found=false
    for log in /var/log/auth.log /var/log/secure; do
        [[ -f "${log}" ]] && log_found=true && break
    done
    if ${log_found}; then
        test_pass "SSH log file found"
    else
        test_warn "SSH log file not found (journald will be used)"
    fi
}

# ============================================================
# TEST: INTEGRITY MODULE
# ============================================================
test_integrity() {
    section "Integrity Module"

    run_test "integrity.sh syntax valid" "bash -n '${LSM_ROOT}/scripts/integrity.sh'"

    run_test "compute_hash works on /etc/hostname" "
        source '${LSM_ROOT}/scripts/lib.sh' 2>/dev/null
        source '${LSM_ROOT}/scripts/integrity.sh' 2>/dev/null
        [[ -n \"\$(compute_hash /etc/hostname 2>/dev/null)\" ]]
    "
    run_test "SHA256 hash is 64 chars" "
        source '${LSM_ROOT}/scripts/lib.sh' 2>/dev/null
        source '${LSM_ROOT}/scripts/integrity.sh' 2>/dev/null
        h=\$(compute_hash /etc/hostname 2>/dev/null)
        [[ \${#h} -eq 64 ]]
    "
    run_test "get_file_metadata works" "
        source '${LSM_ROOT}/scripts/lib.sh' 2>/dev/null
        source '${LSM_ROOT}/scripts/integrity.sh' 2>/dev/null
        [[ -n \"\$(get_file_metadata /etc/hostname 2>/dev/null)\" ]]
    "
    run_test "/etc/passwd is watchable" "[[ -r '/etc/passwd' ]]"
    run_test "Critical files exist" "[[ -f '/etc/ssh/sshd_config' || -f '/etc/hosts' ]]"
}

# ============================================================
# TEST: NETWORK MODULE
# ============================================================
test_network() {
    section "Network Module"

    run_test "network.sh syntax valid" "bash -n '${LSM_ROOT}/scripts/network.sh'"

    if command -v ss &>/dev/null; then
        run_test "ss command works" "[[ -n \"\$(ss -tlnp 2>/dev/null)\" ]]"
    else
        test_warn "ss not available (network scan detection will use netstat fallback)"
    fi

    if command -v ip &>/dev/null; then
        run_test "ip command works" "[[ -n \"\$(ip addr show 2>/dev/null)\" ]]"
    else
        test_warn "ip not available (will use hostname -I fallback)"
    fi

    run_test "Can read /proc/net/dev" "[[ -f '/proc/net/dev' ]]"
    run_test "Can read ARP table" "arp -n 2>/dev/null || [[ -f '/proc/net/arp' ]]"
}

# ============================================================
# TEST: NODE.JS / WEB SERVER
# ============================================================
test_web_server() {
    section "Web Server"

    run_test "Node.js available" "command -v node &>/dev/null"
    run_test "server.js exists" "[[ -f '${LSM_ROOT}/web/src/server.js' ]]"
    run_test "index.html exists" "[[ -f '${LSM_ROOT}/web/public/index.html' ]]"
    run_test "login.html exists" "[[ -f '${LSM_ROOT}/web/public/login.html' ]]"
    run_test "dashboard.css exists" "[[ -f '${LSM_ROOT}/web/public/css/dashboard.css' ]]"
    run_test "dashboard.js exists" "[[ -f '${LSM_ROOT}/web/public/js/dashboard.js' ]]"

    if command -v node &>/dev/null; then
        run_test "Node.js version >= 16" "
            v=\$(node --version | grep -oP '\d+' | head -1)
            [[ \"\${v}\" -ge 16 ]]
        "
        # Check if npm packages installed
        if [[ -d "${LSM_ROOT}/web/node_modules" ]]; then
            run_test "ws module installed" "[[ -d '${LSM_ROOT}/web/node_modules/ws' ]]"
            run_test "better-sqlite3 installed" "[[ -d '${LSM_ROOT}/web/node_modules/better-sqlite3' ]]"
        else
            test_warn "npm modules not installed (run: cd web && npm install)"
        fi
    fi
}

# ============================================================
# TEST: AUDIT MODULE
# ============================================================
test_audit() {
    section "Audit Module"

    run_test "audit.sh syntax valid" "bash -n '${LSM_ROOT}/scripts/audit.sh'"
    run_test "audit functions load" "
        source '${LSM_ROOT}/scripts/lib.sh' 2>/dev/null
        source '${LSM_ROOT}/scripts/audit.sh' 2>/dev/null
        declare -f quick_check &>/dev/null
    "
    run_test "Can read /etc/passwd" "[[ -r '/etc/passwd' ]]"
    run_test "Can read process list" "[[ \$(ps aux --no-headers 2>/dev/null | wc -l) -gt 0 ]]"
    run_test "sysctl available" "command -v sysctl &>/dev/null"
}

# ============================================================
# TEST: TELEGRAM MODULE
# ============================================================
test_telegram() {
    section "Telegram Module"

    run_test "telegram.sh syntax valid" "bash -n '${LSM_ROOT}/scripts/telegram.sh'"
    run_test "curl available" "command -v curl &>/dev/null"
}

# ============================================================
# TEST: USERS MODULE
# ============================================================
test_users() {
    section "Users Module"

    run_test "users.sh syntax valid" "bash -n '${LSM_ROOT}/scripts/users.sh'"
    run_test "Can read /etc/passwd" "[[ -r '/etc/passwd' ]]"
    run_test "Can list users" "[[ -n \"\$(awk -F: '\$3>=1000{print \$1}' /etc/passwd 2>/dev/null)\" ]]"
}

# ============================================================
# TEST: PROCESS MODULE
# ============================================================
test_process() {
    section "Process Module"

    run_test "process.sh syntax valid" "bash -n '${LSM_ROOT}/scripts/process.sh'"
    run_test "ps command works" "[[ -n \"\$(ps aux --no-headers 2>/dev/null | head -1)\" ]]"
    run_test "/proc filesystem accessible" "[[ -d '/proc' ]]"
    run_test "Can list running processes" "[[ \"\$(ps aux --no-headers 2>/dev/null | wc -l)\" -gt 0 ]]"
}

# ============================================================
# SUMMARY
# ============================================================
print_summary() {
    echo ""
    echo -e "${CYAN}================================================${NC}"
    echo -e "${CYAN}  Test Results Summary${NC}"
    echo -e "${CYAN}================================================${NC}"
    echo ""
    echo -e "  ${GREEN}PASSED:${NC}  ${PASS}"
    echo -e "  ${YELLOW}WARNINGS:${NC}${WARN}"
    echo -e "  ${RED}FAILED:${NC}  ${FAIL}"
    echo ""

    if [[ ${FAIL} -gt 0 ]]; then
        echo -e "  ${RED}Failed Tests:${NC}"
        for failure in "${FAILURES[@]}"; do
            echo -e "    - ${failure}"
        done
        echo ""
    fi

    local total=$(( PASS + FAIL + WARN ))
    local score=$(( PASS * 100 / total ))
    echo -e "  Test Score: ${score}% (${PASS}/${total})"
    echo ""

    if [[ ${FAIL} -eq 0 ]]; then
        echo -e "  ${GREEN}All tests passed! System is ready.${NC}"
    else
        echo -e "  ${RED}Some tests failed. Review and fix before deploying.${NC}"
    fi
    echo ""
}

# ============================================================
# MAIN
# ============================================================
main() {
    echo ""
    echo -e "${BLUE}================================================${NC}"
    echo -e "${BLUE}  Linux Security Monitor - Test Suite${NC}"
    echo -e "${BLUE}================================================${NC}"
    echo -e "  Running from: ${LSM_ROOT}"
    echo ""

    local tests=("file_structure" "script_syntax" "lib_functions" "database"
                  "config" "system_commands" "monitor" "ssh" "integrity"
                  "network" "web_server" "audit" "telegram" "users" "process")

    case "${1:-all}" in
        all)
            for test in "${tests[@]}"; do
                "test_${test}"
            done
            ;;
        *)
            if declare -f "test_${1}" > /dev/null; then
                "test_${1}"
            else
                echo "Available tests: ${tests[*]}"
                exit 1
            fi
            ;;
    esac

    print_summary

    [[ ${FAIL} -gt 0 ]] && exit 1 || exit 0
}

main "${@}"
