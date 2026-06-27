#!/bin/bash
# Linux Security Monitor - Daemon Manager

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

MODULE="DAEMON"

LSM_PID_FILE="/var/run/lsm/lsm.pid"
LSM_INSTALL_DIR="/opt/linux-security-monitor"

# ============================================================
# DAEMON LIFECYCLE
# ============================================================
start_daemon() {
    mkdir -p "$(dirname "${LSM_PID_FILE}")"

    if is_running; then
        echo "LSM daemon is already running (PID: $(cat "${LSM_PID_FILE}"))"
        return 1
    fi

    log_info "Starting LSM daemon..." "${MODULE}"

    # Start the main monitoring loop in background
    nohup bash "${SCRIPT_DIR}/monitor.sh" loop >> "${LSM_LOG_DIR}/daemon.log" 2>&1 &
    local daemon_pid=$!
    echo "${daemon_pid}" > "${LSM_PID_FILE}"

    # Start web dashboard if enabled
    if [[ "${WEB_ENABLED:-true}" == "true" ]]; then
        start_web_server
    fi

    # Start integrity monitor (longer interval)
    nohup bash "${SCRIPT_DIR}/integrity.sh" check >> "${LSM_LOG_DIR}/integrity.log" 2>&1 &

    sleep 1
    if is_running; then
        echo "LSM daemon started (PID: ${daemon_pid})"
        log_info "Daemon started with PID ${daemon_pid}" "${MODULE}"
        send_telegram "INFO" "LSM Iniciado" "Monitor de segurança iniciado no servidor $(get_hostname)"
        return 0
    else
        echo "ERROR: Daemon failed to start"
        log_error "Daemon failed to start" "${MODULE}"
        return 1
    fi
}

stop_daemon() {
    if ! is_running; then
        echo "LSM daemon is not running"
        return 0
    fi

    local pid
    pid=$(cat "${LSM_PID_FILE}")
    log_info "Stopping LSM daemon (PID: ${pid})..." "${MODULE}"

    kill "${pid}" 2>/dev/null
    sleep 2

    if kill -0 "${pid}" 2>/dev/null; then
        kill -9 "${pid}" 2>/dev/null
    fi

    rm -f "${LSM_PID_FILE}"

    # Stop web server
    stop_web_server

    echo "LSM daemon stopped"
    log_info "Daemon stopped" "${MODULE}"
}

restart_daemon() {
    stop_daemon
    sleep 2
    start_daemon
}

status_daemon() {
    echo ""
    echo "=== Linux Security Monitor Status ==="
    echo ""

    if is_running; then
        local pid
        pid=$(cat "${LSM_PID_FILE}")
        echo "Daemon: RUNNING (PID: ${pid})"

        # Process uptime
        local start_time
        start_time=$(ps -p "${pid}" -o lstart= 2>/dev/null || echo "unknown")
        echo "Started: ${start_time}"
    else
        echo "Daemon: STOPPED"
    fi

    # Web server
    if pgrep -f "node.*server.js" > /dev/null 2>&1; then
        echo "Web Server: RUNNING (port ${WEB_PORT:-8443})"
    else
        echo "Web Server: STOPPED"
    fi

    echo ""
    echo "=== Current Metrics ==="
    echo "CPU: $(get_cpu_usage)%"
    echo "Memory: $(get_memory_usage)%"
    echo "Load: $(get_load_average)"
    echo "Disk (/): $(get_disk_usage /)%"

    echo ""
    echo "=== Security Summary ==="
    local risk_score
    risk_score=$(db_exec "SELECT COALESCE(score,0) FROM risk_scores ORDER BY timestamp DESC LIMIT 1;" 2>/dev/null || echo 0)
    local risk_level
    risk_level=$(get_risk_level "${risk_score}")
    echo "Risk Score: ${risk_score}/100 (${risk_level})"

    local events_1h
    events_1h=$(db_exec "SELECT COUNT(*) FROM events WHERE timestamp > strftime('%s','now','-1 hour');" 2>/dev/null || echo 0)
    local events_24h
    events_24h=$(db_exec "SELECT COUNT(*) FROM events WHERE timestamp > strftime('%s','now','-24 hours');" 2>/dev/null || echo 0)
    echo "Events (1h/24h): ${events_1h} / ${events_24h}"

    local critical_24h
    critical_24h=$(db_exec "SELECT COUNT(*) FROM events WHERE severity=4 AND timestamp > strftime('%s','now','-24 hours');" 2>/dev/null || echo 0)
    echo "Critical events (24h): ${critical_24h}"

    echo ""
    echo "=== Log Files ==="
    echo "Main log: ${LSM_LOG_DIR}/monitor.log"
    echo "Database: ${LSM_DB_FILE}"
    echo ""
}

is_running() {
    [[ -f "${LSM_PID_FILE}" ]] || return 1
    local pid
    pid=$(cat "${LSM_PID_FILE}")
    kill -0 "${pid}" 2>/dev/null
}

# ============================================================
# WEB SERVER MANAGEMENT
# ============================================================
start_web_server() {
    if ! command_exists node; then
        log_warning "Node.js not found, web dashboard disabled" "${MODULE}"
        return 1
    fi

    local web_dir="${LSM_INSTALL_DIR}/web"
    local web_pid_file="/var/run/lsm/web.pid"

    if [[ -f "${web_pid_file}" ]] && kill -0 "$(cat "${web_pid_file}")" 2>/dev/null; then
        log_debug "Web server already running" "${MODULE}"
        return 0
    fi

    nohup node "${web_dir}/src/server.js" >> "${LSM_LOG_DIR}/web.log" 2>&1 &
    local web_pid=$!
    echo "${web_pid}" > "${web_pid_file}"

    sleep 2
    if kill -0 "${web_pid}" 2>/dev/null; then
        log_info "Web server started (PID: ${web_pid}, port: ${WEB_PORT:-8443})" "${MODULE}"
    else
        log_error "Web server failed to start" "${MODULE}"
        return 1
    fi
}

stop_web_server() {
    local web_pid_file="/var/run/lsm/web.pid"
    if [[ -f "${web_pid_file}" ]]; then
        local pid
        pid=$(cat "${web_pid_file}")
        kill "${pid}" 2>/dev/null || true
        rm -f "${web_pid_file}"
    fi
    pkill -f "node.*server.js" 2>/dev/null || true
}

# ============================================================
# SCHEDULED TASKS
# ============================================================
run_scheduler() {
    log_info "Starting scheduler" "${MODULE}"

    local last_integrity=0
    local last_audit=0
    local last_report=0
    local last_cleanup=0

    while true; do
        local now
        now=$(date +%s)

        # Integrity check every hour
        if [[ $(( now - last_integrity )) -ge ${INTEGRITY_CHECK_INTERVAL:-3600} ]]; then
            bash "${SCRIPT_DIR}/integrity.sh" check >> "${LSM_LOG_DIR}/integrity.log" 2>&1 &
            last_integrity=${now}
        fi

        # Audit every 6 hours
        if [[ $(( now - last_audit )) -ge 21600 ]]; then
            bash "${SCRIPT_DIR}/audit.sh" quick >> "${LSM_LOG_DIR}/audit.log" 2>&1 &
            last_audit=${now}
        fi

        # Daily report
        if [[ $(( now - last_report )) -ge ${REPORT_INTERVAL:-86400} ]]; then
            bash "${SCRIPT_DIR}/telegram.sh" report >> "${LSM_LOG_DIR}/telegram.log" 2>&1 &
            last_report=${now}
        fi

        # Database cleanup every 24h
        if [[ $(( now - last_cleanup )) -ge ${DB_VACUUM_INTERVAL:-86400} ]]; then
            db_cleanup >> "${LSM_LOG_DIR}/db.log" 2>&1 &
            last_cleanup=${now}
        fi

        sleep 60
    done
}

# ============================================================
# WATCHDOG (ensures daemon is always running)
# ============================================================
watchdog() {
    log_info "Starting watchdog" "${MODULE}"

    while true; do
        if ! is_running; then
            log_warning "Daemon not running, restarting..." "${MODULE}"
            start_daemon
        fi
        sleep 30
    done
}

# ============================================================
# MAIN
# ============================================================
main() {
    lsm_init

    case "${1:-status}" in
        start)     start_daemon ;;
        stop)      stop_daemon ;;
        restart)   restart_daemon ;;
        status)    status_daemon ;;
        reload)
            if is_running; then
                local pid
                pid=$(cat "${LSM_PID_FILE}")
                kill -HUP "${pid}" 2>/dev/null && echo "Daemon reloaded"
            else
                echo "Daemon not running"
            fi
            ;;
        scheduler) load_config; run_scheduler ;;
        watchdog)  load_config; watchdog ;;
        web-start) load_config; start_web_server ;;
        web-stop)  stop_web_server ;;
        *)
            echo "Usage: ${0} {start|stop|restart|status|reload|scheduler|watchdog|web-start|web-stop}"
            exit 1
            ;;
    esac
}

main "${@}"
