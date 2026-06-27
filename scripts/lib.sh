#!/bin/bash
# Linux Security Monitor - Shared Library
# Common functions used by all modules

# ============================================================
# CONSTANTS (not readonly so tests can override)
# ============================================================
LSM_VERSION="1.0.0"
LSM_LOG_DIR="${LSM_LOG_DIR:-/var/log/lsm}"
LSM_DATA_DIR="${LSM_DATA_DIR:-/var/lib/lsm}"
LSM_DB_FILE="${LSM_DB_FILE:-${LSM_DATA_DIR}/lsm.db}"
LSM_CONFIG_FILE="${LSM_CONFIG_FILE:-/opt/linux-security-monitor/config/monitor.conf}"
LSM_LOCK_DIR="${LSM_LOCK_DIR:-/var/run/lsm}"

# Colors
readonly RED='\033[0;31m'
readonly YELLOW='\033[1;33m'
readonly GREEN='\033[0;32m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly WHITE='\033[1;37m'
readonly NC='\033[0m'

# Log levels
readonly LOG_DEBUG=0
readonly LOG_INFO=1
readonly LOG_WARNING=2
readonly LOG_ERROR=3
readonly LOG_CRITICAL=4

# Risk levels
readonly RISK_LOW=1
readonly RISK_MEDIUM=2
readonly RISK_HIGH=3
readonly RISK_CRITICAL=4

# ============================================================
# CONFIGURATION LOADING
# ============================================================
load_config() {
    if [[ -f "${LSM_CONFIG_FILE}" ]]; then
        # shellcheck source=/dev/null
        source "${LSM_CONFIG_FILE}"
    fi
    # Set defaults if not configured
    LOG_LEVEL="${LOG_LEVEL:-INFO}"
    CHECK_INTERVAL="${CHECK_INTERVAL:-30}"
    TELEGRAM_ENABLED="${TELEGRAM_ENABLED:-false}"
}

# ============================================================
# LOGGING
# ============================================================
_log_level_num() {
    case "${1}" in
        DEBUG)    echo 0 ;;
        INFO)     echo 1 ;;
        WARNING)  echo 2 ;;
        ERROR)    echo 3 ;;
        CRITICAL) echo 4 ;;
        *)        echo 1 ;;
    esac
}

log() {
    local level="${1}"
    local message="${2}"
    local module="${3:-LSM}"
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    local configured_level
    configured_level=$(_log_level_num "${LOG_LEVEL:-INFO}")
    local msg_level
    msg_level=$(_log_level_num "${level}")

    if [[ ${msg_level} -ge ${configured_level} ]]; then
        local log_file="${LSM_LOG_DIR}/monitor.log"
        mkdir -p "${LSM_LOG_DIR}"
        echo "[${timestamp}] [${level}] [${module}] ${message}" >> "${log_file}"

        # Also log to module-specific file
        local module_log="${LSM_LOG_DIR}/${module,,}.log"
        echo "[${timestamp}] [${level}] ${message}" >> "${module_log}"
    fi
}

log_debug()    { log "DEBUG"    "${1}" "${2:-}"; }
log_info()     { log "INFO"     "${1}" "${2:-}"; }
log_warning()  { log "WARNING"  "${1}" "${2:-}"; }
log_error()    { log "ERROR"    "${1}" "${2:-}"; }
log_critical() { log "CRITICAL" "${1}" "${2:-}"; }

# ============================================================
# DATABASE
# ============================================================
db_init() {
    mkdir -p "${LSM_DATA_DIR}"
    sqlite3 "${LSM_DB_FILE}" <<'ENDSQL'
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    module      TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    severity    INTEGER NOT NULL DEFAULT 1,
    title       TEXT NOT NULL,
    description TEXT,
    source_ip   TEXT,
    username    TEXT,
    process     TEXT,
    raw_data    TEXT,
    risk_score  INTEGER DEFAULT 0,
    acknowledged INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS metrics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    unit        TEXT,
    tags        TEXT
);

CREATE TABLE IF NOT EXISTS integrity_baseline (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filepath    TEXT NOT NULL UNIQUE,
    hash        TEXT NOT NULL,
    permissions TEXT,
    owner       TEXT,
    size        INTEGER,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS integrity_changes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    filepath    TEXT NOT NULL,
    change_type TEXT NOT NULL,
    old_hash    TEXT,
    new_hash    TEXT,
    old_perms   TEXT,
    new_perms   TEXT,
    old_owner   TEXT,
    new_owner   TEXT
);

CREATE TABLE IF NOT EXISTS risk_scores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    score       INTEGER NOT NULL,
    breakdown   TEXT
);

CREATE TABLE IF NOT EXISTS known_processes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    process_name TEXT NOT NULL UNIQUE,
    is_trusted  INTEGER DEFAULT 0,
    added_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS server_info (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp   ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_module      ON events(module);
CREATE INDEX IF NOT EXISTS idx_events_severity    ON events(severity);
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp  ON metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_metrics_name       ON metrics(metric_name);
ENDSQL
    log_info "Database initialized at ${LSM_DB_FILE}" "DB"
}

db_exec() {
    sqlite3 "${LSM_DB_FILE}" "${@}"
}

db_insert_event() {
    local module="${1}"
    local event_type="${2}"
    local severity="${3}"
    local title="${4}"
    local description="${5:-}"
    local source_ip="${6:-}"
    local username="${7:-}"
    local risk_score="${8:-0}"

    db_exec "INSERT INTO events (module, event_type, severity, title, description, source_ip, username, risk_score)
             VALUES ('${module}', '${event_type}', ${severity}, '${title//\'/\'\'}', '${description//\'/\'\'}', '${source_ip}', '${username}', ${risk_score});"
}

db_insert_metric() {
    local metric_name="${1}"
    local metric_value="${2}"
    local unit="${3:-}"
    local tags="${4:-}"

    db_exec "INSERT INTO metrics (metric_name, metric_value, unit, tags)
             VALUES ('${metric_name}', ${metric_value}, '${unit}', '${tags}');"
}

db_cleanup() {
    local retention_days="${DB_RETENTION_DAYS:-90}"
    local cutoff
    cutoff=$(( $(date +%s) - retention_days * 86400 ))
    db_exec "DELETE FROM events WHERE timestamp < ${cutoff};
             DELETE FROM metrics WHERE timestamp < ${cutoff};
             VACUUM;"
    log_info "Database cleanup completed (retention: ${retention_days} days)" "DB"
}

# ============================================================
# RISK SCORE
# ============================================================
calculate_risk_score() {
    local score=0
    local breakdown="{}"

    # Failed logins in last hour
    local failed_logins
    failed_logins=$(db_exec "SELECT COUNT(*) FROM events WHERE module='SSH' AND event_type='FAILED_LOGIN' AND timestamp > strftime('%s','now','-1 hour');")
    score=$(( score + failed_logins * ${RISK_WEIGHT_FAILED_LOGIN:-10} ))

    # Integrity changes in last 24h
    local integrity_changes
    integrity_changes=$(db_exec "SELECT COUNT(*) FROM events WHERE module='INTEGRITY' AND timestamp > strftime('%s','now','-24 hours');")
    score=$(( score + integrity_changes * ${RISK_WEIGHT_INTEGRITY:-25} ))

    # Suspicious processes in last hour
    local suspicious_procs
    suspicious_procs=$(db_exec "SELECT COUNT(*) FROM events WHERE module='PROCESS' AND severity >= 3 AND timestamp > strftime('%s','now','-1 hour');")
    score=$(( score + suspicious_procs * ${RISK_WEIGHT_SUSPICIOUS_PROCESS:-20} ))

    # Cap at 100
    [[ ${score} -gt 100 ]] && score=100

    db_exec "INSERT INTO risk_scores (score, breakdown) VALUES (${score}, '${breakdown}');"
    echo "${score}"
}

get_risk_level() {
    local score="${1}"
    if [[ ${score} -ge 75 ]]; then
        echo "CRITICAL"
    elif [[ ${score} -ge 50 ]]; then
        echo "HIGH"
    elif [[ ${score} -ge 25 ]]; then
        echo "MEDIUM"
    else
        echo "LOW"
    fi
}

# ============================================================
# TELEGRAM ALERTS
# ============================================================
send_telegram() {
    local level="${1}"
    local title="${2}"
    local message="${3}"

    [[ "${TELEGRAM_ENABLED}" != "true" ]] && return 0
    [[ -z "${TELEGRAM_BOT_TOKEN}" ]] && return 0
    [[ -z "${TELEGRAM_CHAT_ID}" ]] && return 0

    local emoji
    case "${level}" in
        CRITICAL) emoji="🔴" ;;
        HIGH)     emoji="🟠" ;;
        WARNING)  emoji="🟡" ;;
        INFO)     emoji="🔵" ;;
        *)        emoji="⚪" ;;
    esac

    local hostname
    hostname=$(hostname -f 2>/dev/null || hostname)
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    local text
    text="${emoji} *[${level}] ${title}*
🖥️ Server: \`${hostname}\`
🕐 Time: ${timestamp}

${message}"

    curl -s -X POST \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        -d "parse_mode=Markdown" \
        -d "text=${text}" \
        --max-time 10 \
        --retry 3 \
        > /dev/null 2>&1
}

# ============================================================
# SYSTEM INFO
# ============================================================
get_hostname() { hostname -f 2>/dev/null || hostname; }

get_public_ip() {
    curl -s --max-time 5 https://ipinfo.io/ip 2>/dev/null || echo "unknown"
}

get_private_ip() {
    ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}'
}

get_os_info() {
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        echo "${PRETTY_NAME:-Unknown}"
    else
        uname -s
    fi
}

get_kernel() { uname -r; }
get_uptime_seconds() { cat /proc/uptime | awk '{print int($1)}'; }

get_cpu_usage() {
    top -bn1 | grep "Cpu(s)" | sed "s/.*, *\([0-9.]*\)%* id.*/\1/" | awk '{print 100 - $1}'
}

get_memory_usage() {
    free | grep Mem | awk '{printf "%.1f", $3/$2 * 100}'
}

get_disk_usage() {
    local path="${1:-/}"
    df -h "${path}" | tail -1 | awk '{print $5}' | tr -d '%'
}

get_load_average() {
    uptime | grep -oP 'load average: \K[0-9.]+' | head -1
}

# ============================================================
# LOCKING (prevent duplicate runs)
# ============================================================
acquire_lock() {
    local lock_name="${1}"
    local lock_file="${LSM_LOCK_DIR}/${lock_name}.lock"
    mkdir -p "${LSM_LOCK_DIR}"

    if [[ -f "${lock_file}" ]]; then
        local pid
        pid=$(cat "${lock_file}")
        if kill -0 "${pid}" 2>/dev/null; then
            return 1  # Already running
        fi
    fi

    echo $$ > "${lock_file}"
    return 0
}

release_lock() {
    local lock_name="${1}"
    rm -f "${LSM_LOCK_DIR}/${lock_name}.lock"
}

# ============================================================
# UTILITIES
# ============================================================
is_ip_address() {
    local ip="${1}"
    [[ "${ip}" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]
}

is_private_ip() {
    local ip="${1}"
    [[ "${ip}" =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.) ]]
}

escape_sql() {
    echo "${1}" | sed "s/'/''/g"
}

notify_websocket() {
    local event_type="${1}"
    local data="${2}"

    local ws_socket="${LSM_DATA_DIR}/lsm.sock"
    if [[ -S "${ws_socket}" ]]; then
        echo "{\"type\":\"${event_type}\",\"data\":${data}}" | nc -U "${ws_socket}" 2>/dev/null || true
    fi
}

command_exists() {
    command -v "${1}" &>/dev/null
}

ensure_commands() {
    local missing=()
    for cmd in "${@}"; do
        command_exists "${cmd}" || missing+=("${cmd}")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required commands: ${missing[*]}" "LIB"
        return 1
    fi
    return 0
}

# ============================================================
# INITIALIZATION
# ============================================================
lsm_init() {
    load_config
    mkdir -p "${LSM_LOG_DIR}" "${LSM_DATA_DIR}" "${LSM_LOCK_DIR}"
    db_init
}
