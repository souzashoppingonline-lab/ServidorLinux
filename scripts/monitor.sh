#!/bin/bash
# Linux Security Monitor - Main Monitoring Orchestrator

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

MODULE="MONITOR"

# ============================================================
# SYSTEM METRICS COLLECTION
# ============================================================
collect_system_metrics() {
    log_debug "Collecting system metrics" "${MODULE}"

    # CPU
    local cpu
    cpu=$(get_cpu_usage)
    db_insert_metric "cpu_usage" "${cpu}" "%" "host=$(get_hostname)"

    # Memory
    local mem
    mem=$(get_memory_usage)
    db_insert_metric "memory_usage" "${mem}" "%" "host=$(get_hostname)"

    # Load average
    local load
    load=$(get_load_average)
    db_insert_metric "load_avg_1m" "${load}" "" "host=$(get_hostname)"

    # Disk for all mounted filesystems
    while read -r line; do
        local mount_point usage
        mount_point=$(echo "${line}" | awk '{print $6}')
        usage=$(echo "${line}" | awk '{print $5}' | tr -d '%')
        [[ -z "${usage}" ]] && continue
        db_insert_metric "disk_usage" "${usage}" "%" "mount=${mount_point}"
    done < <(df -h --output=source,size,used,avail,pcent,target 2>/dev/null | tail -n +2 | grep -v tmpfs)

    # Network I/O
    if [[ -f /proc/net/dev ]]; then
        while read -r iface rx_bytes tx_bytes; do
            [[ "${iface}" == "lo:" ]] && continue
            db_insert_metric "net_rx_bytes" "${rx_bytes}" "bytes" "iface=${iface%:}"
            db_insert_metric "net_tx_bytes" "${tx_bytes}" "bytes" "iface=${iface%:}"
        done < <(grep -E '^\s*[a-z]' /proc/net/dev | awk '{print $1, $2, $10}')
    fi

    # Active connections
    local conn_count
    conn_count=$(ss -tn 2>/dev/null | grep -c ESTAB || echo 0)
    db_insert_metric "active_connections" "${conn_count}" "count" ""

    log_debug "System metrics collected: CPU=${cpu}% MEM=${mem}% LOAD=${load}" "${MODULE}"
}

# ============================================================
# CPU ALERT CHECK
# ============================================================
check_cpu_alert() {
    local cpu
    cpu=$(get_cpu_usage)
    local threshold="${CPU_ALERT_THRESHOLD:-85}"

    if (( $(echo "${cpu} > ${threshold}" | bc -l) )); then
        local top_process
        top_process=$(ps aux --sort=-%cpu | awk 'NR==2{print $11" (PID:"$2" CPU:"$3"%)"}')

        db_insert_event "RESOURCES" "HIGH_CPU" 3 "Alto uso de CPU: ${cpu}%" \
            "CPU em ${cpu}%, acima do limite de ${threshold}%. Processo: ${top_process}" \
            "" "" 5

        send_telegram "WARNING" "Alto Uso de CPU" \
"📊 Uso atual: ${cpu}%
🔧 Processo: ${top_process}
⚠️ Limite configurado: ${threshold}%"

        log_warning "High CPU usage: ${cpu}% (threshold: ${threshold}%)" "${MODULE}"
    fi
}

# ============================================================
# MEMORY ALERT CHECK
# ============================================================
check_memory_alert() {
    local mem
    mem=$(get_memory_usage)
    local threshold="${MEMORY_ALERT_THRESHOLD:-90}"

    if (( $(echo "${mem} > ${threshold}" | bc -l) )); then
        local mem_info
        mem_info=$(free -h | grep Mem | awk '{print "Total:"$2" Used:"$3" Free:"$4}')

        db_insert_event "RESOURCES" "HIGH_MEMORY" 3 "Alto uso de memória: ${mem}%" \
            "${mem_info}" "" "" 5

        send_telegram "WARNING" "Alto Uso de Memória" \
"📊 Uso atual: ${mem}%
💾 ${mem_info}
⚠️ Limite configurado: ${threshold}%"

        log_warning "High memory usage: ${mem}% (threshold: ${threshold}%)" "${MODULE}"
    fi
}

# ============================================================
# DISK ALERT CHECK
# ============================================================
check_disk_alert() {
    local threshold="${DISK_ALERT_THRESHOLD:-85}"

    while read -r line; do
        local mount_point usage device
        device=$(echo "${line}" | awk '{print $1}')
        usage=$(echo "${line}" | awk '{print $5}' | tr -d '%')
        mount_point=$(echo "${line}" | awk '{print $6}')

        [[ -z "${usage}" ]] && continue
        [[ "${usage}" -gt "${threshold}" ]] && {
            db_insert_event "RESOURCES" "HIGH_DISK" 2 "Disco cheio: ${mount_point} ${usage}%" \
                "Dispositivo ${device} em ${mount_point} usando ${usage}%" "" "" 5

            send_telegram "WARNING" "Disco Quase Cheio" \
"💾 Partição: ${mount_point}
📊 Uso: ${usage}%
🔧 Dispositivo: ${device}"

            log_warning "High disk usage: ${mount_point} at ${usage}%" "${MODULE}"
        }
    done < <(df --output=source,size,used,avail,pcent,target 2>/dev/null | tail -n +2 | grep -v tmpfs)
}

# ============================================================
# LOAD AVERAGE CHECK
# ============================================================
check_load_alert() {
    local load
    load=$(get_load_average)
    local threshold="${LOAD_ALERT_THRESHOLD:-4.0}"
    local cpu_cores
    cpu_cores=$(nproc 2>/dev/null || echo 1)

    if (( $(echo "${load} > ${threshold}" | bc -l) )); then
        db_insert_event "RESOURCES" "HIGH_LOAD" 3 "Load average alto: ${load}" \
            "Load average ${load} com ${cpu_cores} CPU(s)" "" "" 5

        send_telegram "WARNING" "Load Average Alto" \
"📊 Load: ${load}
🖥️ CPUs: ${cpu_cores}
⚠️ Limite: ${threshold}"

        log_warning "High load average: ${load} (threshold: ${threshold}, CPUs: ${cpu_cores})" "${MODULE}"
    fi
}

# ============================================================
# OPEN PORTS CHECK
# ============================================================
check_open_ports() {
    log_debug "Checking open ports" "${MODULE}"

    local current_ports
    current_ports=$(ss -tlnp 2>/dev/null | awk 'NR>1 {print $4}' | grep -oP ':\K[0-9]+' | sort -n | uniq)

    local prev_ports_file="${LSM_DATA_DIR}/known_ports.txt"

    if [[ -f "${prev_ports_file}" ]]; then
        local prev_ports
        prev_ports=$(cat "${prev_ports_file}")

        # Find new ports
        while read -r port; do
            if ! echo "${prev_ports}" | grep -qx "${port}"; then
                local service
                service=$(getent services "${port}/tcp" 2>/dev/null | awk '{print $1}' || echo "unknown")

                db_insert_event "NETWORK" "NEW_PORT_OPEN" 3 "Nova porta aberta: ${port}" \
                    "Porta ${port} (${service}) foi aberta" "" "" 10

                send_telegram "WARNING" "Nova Porta Aberta" \
"🔌 Porta: ${port}
🔧 Serviço: ${service}
📌 Verifique se foi intencional"

                log_warning "New port opened: ${port} (${service})" "${MODULE}"
            fi
        done < <(echo "${current_ports}")

        # Find closed ports
        while read -r port; do
            if ! echo "${current_ports}" | grep -qx "${port}"; then
                db_insert_event "NETWORK" "PORT_CLOSED" 1 "Porta fechada: ${port}" \
                    "Porta ${port} foi fechada" "" "" 0
                log_info "Port closed: ${port}" "${MODULE}"
            fi
        done < <(echo "${prev_ports}")
    fi

    echo "${current_ports}" > "${prev_ports_file}"
}

# ============================================================
# FIREWALL STATUS CHECK
# ============================================================
check_firewall() {
    log_debug "Checking firewall status" "${MODULE}"

    local fw_status="unknown"
    local fw_tool=""

    if command_exists ufw; then
        fw_tool="ufw"
        fw_status=$(ufw status 2>/dev/null | head -1 | awk '{print $2}')
        if [[ "${fw_status}" != "active" ]]; then
            db_insert_event "FIREWALL" "FIREWALL_DISABLED" 4 "Firewall UFW está inativo" \
                "UFW firewall não está ativo - servidor desprotegido" "" "" 20

            send_telegram "CRITICAL" "Firewall Desativado" \
"⛔ UFW está INATIVO
🖥️ Servidor sem proteção de firewall
📌 Execute: ufw enable"

            log_critical "UFW firewall is inactive" "${MODULE}"
        fi
    elif command_exists firewall-cmd; then
        fw_tool="firewalld"
        if ! firewall-cmd --state &>/dev/null; then
            db_insert_event "FIREWALL" "FIREWALL_DISABLED" 4 "Firewall FirewallD está inativo" \
                "FirewallD não está em execução" "" "" 20
            log_critical "FirewallD is inactive" "${MODULE}"
        fi
    elif command_exists iptables; then
        fw_tool="iptables"
        local rules_count
        rules_count=$(iptables -L 2>/dev/null | grep -c "^Chain" || echo 0)
        if [[ "${rules_count}" -lt 3 ]]; then
            db_insert_event "FIREWALL" "FIREWALL_MINIMAL" 2 "IPTables sem regras configuradas" \
                "Nenhuma regra de firewall encontrada" "" "" 10
            log_warning "IPTables has no rules configured" "${MODULE}"
        fi
    else
        db_insert_event "FIREWALL" "NO_FIREWALL" 3 "Nenhum firewall detectado" \
            "Nenhuma ferramenta de firewall encontrada no sistema" "" "" 15
        log_warning "No firewall tool detected" "${MODULE}"
    fi

    db_insert_metric "firewall_active" "$([[ "${fw_status}" == "active" ]] && echo 1 || echo 0)" "" "tool=${fw_tool}"
}

# ============================================================
# DOCKER CHECK
# ============================================================
check_docker() {
    [[ "${ENABLE_DOCKER_MONITOR}" != "true" ]] && return 0
    command_exists docker || return 0

    log_debug "Checking Docker containers" "${MODULE}"

    # Count containers
    local running
    running=$(docker ps --format '{{.Names}}' 2>/dev/null | wc -l)
    local stopped
    stopped=$(docker ps -a --filter "status=exited" --format '{{.Names}}' 2>/dev/null | wc -l)

    db_insert_metric "docker_running" "${running}" "count" ""
    db_insert_metric "docker_stopped" "${stopped}" "count" ""

    # Check for containers running as root with privileged flag
    while read -r container_name; do
        [[ -z "${container_name}" ]] && continue

        local is_privileged
        is_privileged=$(docker inspect "${container_name}" 2>/dev/null | python3 -c \
            "import json,sys; d=json.load(sys.stdin); print(d[0]['HostConfig']['Privileged'])" 2>/dev/null)

        if [[ "${is_privileged}" == "True" ]]; then
            db_insert_event "DOCKER" "PRIVILEGED_CONTAINER" 3 "Container privilegiado: ${container_name}" \
                "Container rodando em modo privilegiado é um risco de segurança" "" "" 15

            log_warning "Privileged Docker container detected: ${container_name}" "${MODULE}"
        fi
    done < <(docker ps --format '{{.Names}}' 2>/dev/null)

    log_debug "Docker check: ${running} running, ${stopped} stopped" "${MODULE}"
}

# ============================================================
# SSL CERTIFICATE CHECK
# ============================================================
check_ssl_certs() {
    [[ "${ENABLE_SSL_MONITOR}" != "true" ]] && return 0
    command_exists openssl || return 0

    log_debug "Checking SSL certificates" "${MODULE}"

    local warn_days=30

    # Check Let's Encrypt certs
    for cert_dir in /etc/letsencrypt/live/*/; do
        [[ -d "${cert_dir}" ]] || continue
        local domain
        domain=$(basename "${cert_dir}")
        local cert_file="${cert_dir}fullchain.pem"
        [[ -f "${cert_file}" ]] || continue

        local expiry_date
        expiry_date=$(openssl x509 -in "${cert_file}" -noout -enddate 2>/dev/null | cut -d= -f2)
        local expiry_epoch
        expiry_epoch=$(date -d "${expiry_date}" +%s 2>/dev/null || echo 0)
        local now_epoch
        now_epoch=$(date +%s)
        local days_left
        days_left=$(( (expiry_epoch - now_epoch) / 86400 ))

        db_insert_metric "ssl_days_remaining" "${days_left}" "days" "domain=${domain}"

        if [[ ${days_left} -le 7 ]]; then
            db_insert_event "SSL" "SSL_CRITICAL" 4 "Certificado SSL expira em ${days_left} dias: ${domain}" \
                "Certificado expira em ${expiry_date}" "" "" 20
            send_telegram "CRITICAL" "Certificado SSL Expirando URGENTE" \
"🌐 Domínio: ${domain}
📅 Expira em: ${days_left} dias
⛔ RENOVAÇÃO IMEDIATA NECESSÁRIA"
            log_critical "SSL cert expires in ${days_left} days: ${domain}" "${MODULE}"
        elif [[ ${days_left} -le ${warn_days} ]]; then
            db_insert_event "SSL" "SSL_EXPIRING" 2 "Certificado SSL expira em ${days_left} dias: ${domain}" \
                "Certificado expira em ${expiry_date}" "" "" 10
            send_telegram "WARNING" "Certificado SSL Expirando" \
"🌐 Domínio: ${domain}
📅 Expira em: ${days_left} dias"
            log_warning "SSL cert expires in ${days_left} days: ${domain}" "${MODULE}"
        fi
    done

    # Check running HTTPS services
    for port in 443 8443; do
        if ss -tlnp 2>/dev/null | grep -q ":${port}"; then
            local cert_info
            cert_info=$(echo | timeout 5 openssl s_client -connect "localhost:${port}" 2>/dev/null | openssl x509 -noout -dates 2>/dev/null)
            if [[ -n "${cert_info}" ]]; then
                local expiry
                expiry=$(echo "${cert_info}" | grep notAfter | cut -d= -f2)
                local expiry_epoch
                expiry_epoch=$(date -d "${expiry}" +%s 2>/dev/null || echo 0)
                local days_left
                days_left=$(( (expiry_epoch - $(date +%s)) / 86400 ))
                db_insert_metric "ssl_days_remaining" "${days_left}" "days" "port=${port}"
            fi
        fi
    done
}

# ============================================================
# CRON JOBS CHECK
# ============================================================
check_cron_jobs() {
    [[ "${ENABLE_CRON_MONITOR}" != "true" ]] && return 0

    log_debug "Checking cron jobs" "${MODULE}"

    local cron_snapshot_file="${LSM_DATA_DIR}/cron_snapshot.txt"
    local current_crons=""

    # Gather all cron jobs
    {
        [[ -f /etc/crontab ]] && cat /etc/crontab
        for f in /etc/cron.d/*; do [[ -f "${f}" ]] && cat "${f}"; done
        for user in $(cut -f1 -d: /etc/passwd); do
            crontab -l -u "${user}" 2>/dev/null | sed "s/^/${user}: /"
        done
    } > /tmp/lsm_crons_current.txt

    if [[ -f "${cron_snapshot_file}" ]]; then
        local diff_output
        diff_output=$(diff "${cron_snapshot_file}" /tmp/lsm_crons_current.txt 2>/dev/null || true)

        if [[ -n "${diff_output}" ]]; then
            local added
            added=$(echo "${diff_output}" | grep '^>' | grep -v '^---' | head -5)
            local removed
            removed=$(echo "${diff_output}" | grep '^<' | grep -v '^---' | head -5)

            if [[ -n "${added}" ]]; then
                db_insert_event "CRON" "CRON_ADDED" 2 "Novo cron job adicionado" \
                    "${added}" "" "" 10
                log_warning "New cron job detected: ${added}" "${MODULE}"
            fi

            if [[ -n "${removed}" ]]; then
                db_insert_event "CRON" "CRON_REMOVED" 1 "Cron job removido" \
                    "${removed}" "" "" 0
                log_info "Cron job removed: ${removed}" "${MODULE}"
            fi
        fi
    fi

    cp /tmp/lsm_crons_current.txt "${cron_snapshot_file}"
    rm -f /tmp/lsm_crons_current.txt
}

# ============================================================
# MAIN MONITORING LOOP
# ============================================================
run_all_checks() {
    log_info "Running monitoring checks..." "${MODULE}"

    collect_system_metrics
    check_cpu_alert
    check_memory_alert
    check_disk_alert
    check_load_alert
    check_open_ports
    check_firewall
    check_docker
    check_ssl_certs
    check_cron_jobs

    # Run submodule scripts
    local scripts_dir="${SCRIPT_DIR}"
    for module_script in ssh users process network integrity audit; do
        local script="${scripts_dir}/${module_script}.sh"
        if [[ -x "${script}" ]]; then
            bash "${script}" check 2>> "${LSM_LOG_DIR}/monitor.log" || true
        fi
    done

    # Update risk score
    calculate_risk_score > /dev/null 2>&1 || true

    # Notify web dashboard
    notify_websocket "metrics_update" "{\"timestamp\":$(date +%s)}"

    log_info "All checks completed" "${MODULE}"
}

main() {
    lsm_init
    load_config

    case "${1:-}" in
        check)
            run_all_checks
            ;;
        metrics)
            collect_system_metrics
            ;;
        once)
            run_all_checks
            ;;
        loop)
            log_info "Starting monitoring loop (interval: ${CHECK_INTERVAL}s)" "${MODULE}"
            while true; do
                run_all_checks
                sleep "${CHECK_INTERVAL}"
            done
            ;;
        status)
            local score
            score=$(db_exec "SELECT COALESCE(score,0) FROM risk_scores ORDER BY timestamp DESC LIMIT 1;" 2>/dev/null || echo "0")
            local level
            level=$(get_risk_level "${score}")
            echo "Risk Score: ${score}/100 (${level})"
            echo "CPU: $(get_cpu_usage)%"
            echo "Memory: $(get_memory_usage)%"
            echo "Load: $(get_load_average)"
            ;;
        *)
            echo "Usage: ${0} {check|metrics|once|loop|status}"
            exit 1
            ;;
    esac
}

main "${@}"
