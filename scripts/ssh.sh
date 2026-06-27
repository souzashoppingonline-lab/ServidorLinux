#!/bin/bash
# Linux Security Monitor - SSH Monitor Module

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

MODULE="SSH"

# ============================================================
# SSH LOG POSITION TRACKING
# ============================================================
get_log_position_file() {
    echo "${LSM_DATA_DIR}/ssh_log_pos.txt"
}

save_log_position() {
    local log_file="${1}"
    local pos
    pos=$(wc -l < "${log_file}" 2>/dev/null || echo 0)
    echo "${pos}" > "$(get_log_position_file)"
}

get_last_position() {
    local pos_file
    pos_file=$(get_log_position_file)
    if [[ -f "${pos_file}" ]]; then
        cat "${pos_file}"
    else
        echo 0
    fi
}

# ============================================================
# DETECT SSH LOG FILE
# ============================================================
get_ssh_log() {
    for log_file in /var/log/auth.log /var/log/secure /var/log/messages; do
        [[ -f "${log_file}" ]] && { echo "${log_file}"; return 0; }
    done
    # Use journald as fallback
    echo "journald"
}

get_ssh_lines() {
    local log_file
    log_file=$(get_ssh_log)
    local last_pos
    last_pos=$(get_last_position)

    if [[ "${log_file}" == "journald" ]]; then
        journalctl -u ssh -u sshd --since "1 minute ago" --no-pager -q 2>/dev/null || true
    else
        local total_lines
        total_lines=$(wc -l < "${log_file}" 2>/dev/null || echo 0)
        if [[ ${total_lines} -gt ${last_pos} ]]; then
            tail -n +$(( last_pos + 1 )) "${log_file}"
            save_log_position "${log_file}"
        fi
    fi
}

# ============================================================
# FAILED LOGIN TRACKING
# ============================================================
check_failed_logins() {
    local log_file
    log_file=$(get_ssh_log)
    local threshold="${FAILED_LOGIN_THRESHOLD:-5}"
    local window_minutes=10

    local auth_log
    if [[ "${log_file}" == "journald" ]]; then
        auth_log=$(journalctl -u ssh -u sshd --since "${window_minutes} minutes ago" --no-pager -q 2>/dev/null || true)
    else
        auth_log=$(tail -n 1000 "${log_file}" 2>/dev/null || true)
    fi

    # Extract failed login IPs
    declare -A ip_counts
    while read -r ip; do
        [[ -z "${ip}" ]] && continue
        ip_counts["${ip}"]=$(( ${ip_counts["${ip}"]:-0} + 1 ))
    done < <(echo "${auth_log}" | grep -E "Failed password|Invalid user|authentication failure" | \
             grep -oP '(?<=from )\d+\.\d+\.\d+\.\d+' || true)

    for ip in "${!ip_counts[@]}"; do
        local count="${ip_counts[${ip}]}"
        if [[ ${count} -ge ${threshold} ]]; then
            # Check if we already alerted for this IP recently
            local recent_alert
            recent_alert=$(db_exec "SELECT COUNT(*) FROM events WHERE module='SSH' AND event_type='BRUTE_FORCE' AND source_ip='${ip}' AND timestamp > strftime('%s','now','-30 minutes');" 2>/dev/null || echo 0)

            if [[ "${recent_alert}" == "0" ]]; then
                local risk
                risk=$(( count * RISK_WEIGHT_FAILED_LOGIN ))
                [[ ${risk} -gt 50 ]] && risk=50

                db_insert_event "SSH" "BRUTE_FORCE" 4 "Ataque de força bruta SSH: ${ip}" \
                    "${count} tentativas de login falhas em ${window_minutes} minutos" \
                    "${ip}" "" "${risk}"

                send_telegram "CRITICAL" "Ataque de Força Bruta SSH" \
"🌍 IP: \`${ip}\`
🔢 Tentativas: ${count} em ${window_minutes} min
⛔ Possível ataque de força bruta
📌 Considere bloquear: fail2ban-client set sshd banip ${ip}"

                log_critical "SSH brute force from ${ip}: ${count} attempts" "${MODULE}"

                # Auto-block with fail2ban if available
                if command_exists fail2ban-client; then
                    fail2ban-client set sshd banip "${ip}" 2>/dev/null && \
                        log_info "Auto-banned ${ip} via fail2ban" "${MODULE}"
                fi
            fi
        fi
    done
}

# ============================================================
# SUCCESSFUL LOGIN MONITORING
# ============================================================
check_successful_logins() {
    local new_lines
    new_lines=$(get_ssh_lines)
    [[ -z "${new_lines}" ]] && return 0

    # Accepted logins
    while read -r line; do
        local user ip method
        user=$(echo "${line}" | grep -oP '(?<=for )\w+' | head -1)
        ip=$(echo "${line}" | grep -oP '(?<=from )\d+\.\d+\.\d+\.\d+' | head -1)
        method=$(echo "${line}" | grep -oP '(?<=Accepted )\w+' | head -1)

        [[ -z "${user}" || -z "${ip}" ]] && continue

        local severity=1
        local risk=0
        local desc="Login SSH aceito: usuário ${user} de ${ip} via ${method:-unknown}"

        # Root login is critical
        if [[ "${user}" == "root" ]]; then
            severity=4
            risk=${RISK_WEIGHT_ROOT_LOGIN:-20}
            db_insert_event "SSH" "ROOT_LOGIN" ${severity} "Login root via SSH: ${ip}" \
                "${desc}" "${ip}" "${user}" "${risk}"

            send_telegram "CRITICAL" "Login Root via SSH" \
"👤 Usuário: root
🌍 IP: \`${ip}\`
🔐 Método: ${method:-unknown}
⛔ LOGIN ROOT É UMA PRÁTICA INSEGURA"

            log_critical "Root SSH login from ${ip}" "${MODULE}"
        else
            # Check if IP is outside trusted networks
            if ! is_private_ip "${ip}"; then
                severity=2
                risk=5
            fi

            db_insert_event "SSH" "LOGIN_SUCCESS" ${severity} "Login SSH: ${user} de ${ip}" \
                "${desc}" "${ip}" "${user}" "${risk}"

            log_info "SSH login: ${user} from ${ip}" "${MODULE}"
        fi
    done < <(echo "${new_lines}" | grep "Accepted " || true)

    # Failed logins
    while read -r line; do
        local user ip
        user=$(echo "${line}" | grep -oP '(?<=for (invalid user )?)\w+' | head -1)
        ip=$(echo "${line}" | grep -oP '(?<=from )\d+\.\d+\.\d+\.\d+' | head -1)

        [[ -z "${ip}" ]] && continue

        db_insert_event "SSH" "FAILED_LOGIN" 2 "Tentativa de login SSH falhou: ${user:-unknown} de ${ip}" \
            "Falha de autenticação" "${ip}" "${user:-unknown}" 0

        log_info "Failed SSH login from ${ip} for user ${user:-unknown}" "${MODULE}"
    done < <(echo "${new_lines}" | grep -E "Failed password|Invalid user" || true)

    # Disconnections with error
    while read -r line; do
        local ip
        ip=$(echo "${line}" | grep -oP '(?<=from )\d+\.\d+\.\d+\.\d+' | head -1)
        [[ -z "${ip}" ]] && continue

        # Only log if many errors from same IP
        local count
        count=$(db_exec "SELECT COUNT(*) FROM events WHERE module='SSH' AND source_ip='${ip}' AND timestamp > strftime('%s','now','-5 minutes');" 2>/dev/null || echo 0)
        [[ ${count} -gt 10 ]] && {
            db_insert_event "SSH" "CONNECTION_ERROR" 2 "Erro de conexão SSH de ${ip}" \
                "${line}" "${ip}" "" 5
        }
    done < <(echo "${new_lines}" | grep "error:" || true)
}

# ============================================================
# ACTIVE SSH SESSION MONITORING
# ============================================================
check_active_sessions() {
    log_debug "Checking active SSH sessions" "${MODULE}"

    local sessions_file="${LSM_DATA_DIR}/active_sessions.txt"
    local current_sessions
    current_sessions=$(who 2>/dev/null | grep -v "^$" || true)

    if [[ -f "${sessions_file}" ]]; then
        local prev_sessions
        prev_sessions=$(cat "${sessions_file}")

        # New sessions
        while read -r session; do
            [[ -z "${session}" ]] && continue
            if ! echo "${prev_sessions}" | grep -qF "${session}"; then
                local user term from
                user=$(echo "${session}" | awk '{print $1}')
                term=$(echo "${session}" | awk '{print $2}')
                from=$(echo "${session}" | awk '{print $NF}' | tr -d '()')

                db_insert_event "SSH" "SESSION_OPENED" 1 "Nova sessão SSH: ${user}" \
                    "Usuário ${user} conectou de ${from}" "${from}" "${user}" 0
                log_info "New session: ${user} from ${from}" "${MODULE}"
            fi
        done < <(echo "${current_sessions}")

        # Closed sessions
        while read -r session; do
            [[ -z "${session}" ]] && continue
            if ! echo "${current_sessions}" | grep -qF "${session}"; then
                local user
                user=$(echo "${session}" | awk '{print $1}')
                db_insert_event "SSH" "SESSION_CLOSED" 1 "Sessão SSH encerrada: ${user}" \
                    "Sessão de ${user} foi encerrada" "" "${user}" 0
            fi
        done < <(echo "${prev_sessions}")
    fi

    echo "${current_sessions}" > "${sessions_file}"
    db_insert_metric "active_sessions" "$(echo "${current_sessions}" | grep -c . || echo 0)" "count" ""
}

# ============================================================
# SSH CONFIG AUDIT
# ============================================================
audit_ssh_config() {
    local config_file="/etc/ssh/sshd_config"
    [[ -f "${config_file}" ]] || return 0

    log_info "Auditing SSH configuration" "${MODULE}"

    local issues=0

    # Check root login
    if grep -qiE "^PermitRootLogin\s+yes" "${config_file}"; then
        db_insert_event "SSH" "CONFIG_ISSUE" 3 "SSH: Root login permitido" \
            "PermitRootLogin yes está configurado em ${config_file}" "" "" 15
        log_warning "SSH allows root login" "${MODULE}"
        (( issues++ ))
    fi

    # Check password authentication
    if ! grep -qiE "^PasswordAuthentication\s+no" "${config_file}"; then
        db_insert_event "SSH" "CONFIG_WARN" 2 "SSH: Autenticação por senha habilitada" \
            "PasswordAuthentication não está desabilitada. Prefira chaves SSH." "" "" 5
        log_info "SSH password authentication is enabled (consider using keys)" "${MODULE}"
    fi

    # Check empty passwords
    if grep -qiE "^PermitEmptyPasswords\s+yes" "${config_file}"; then
        db_insert_event "SSH" "CONFIG_CRITICAL" 4 "SSH: Senhas vazias permitidas" \
            "PermitEmptyPasswords yes - CRÍTICO" "" "" 25
        send_telegram "CRITICAL" "Configuração SSH Crítica" \
"⛔ PermitEmptyPasswords está habilitado
📄 Arquivo: ${config_file}
📌 Isso permite login sem senha!"
        log_critical "SSH allows empty passwords - CRITICAL" "${MODULE}"
        (( issues++ ))
    fi

    # Check protocol version
    if grep -qiE "^Protocol\s+1" "${config_file}"; then
        db_insert_event "SSH" "CONFIG_ISSUE" 3 "SSH: Protocolo v1 habilitado (inseguro)" \
            "Protocolo SSH v1 é inseguro" "" "" 20
        log_warning "SSH Protocol 1 is enabled (insecure)" "${MODULE}"
        (( issues++ ))
    fi

    local port
    port=$(grep -iE "^Port\s+" "${config_file}" | awk '{print $2}' || echo "22")
    db_insert_metric "ssh_port" "${port}" "port" ""

    if [[ ${issues} -gt 0 ]]; then
        log_warning "SSH config audit found ${issues} security issues" "${MODULE}"
    else
        log_info "SSH config audit passed" "${MODULE}"
    fi
}

# ============================================================
# MAIN
# ============================================================
main() {
    lsm_init

    case "${1:-check}" in
        check)
            check_failed_logins
            check_successful_logins
            check_active_sessions
            ;;
        audit)
            audit_ssh_config
            ;;
        full)
            check_failed_logins
            check_successful_logins
            check_active_sessions
            audit_ssh_config
            ;;
        status)
            local failed
            failed=$(db_exec "SELECT COUNT(*) FROM events WHERE module='SSH' AND event_type='FAILED_LOGIN' AND timestamp > strftime('%s','now','-1 hour');" 2>/dev/null || echo 0)
            local logins
            logins=$(db_exec "SELECT COUNT(*) FROM events WHERE module='SSH' AND event_type='LOGIN_SUCCESS' AND timestamp > strftime('%s','now','-24 hours');" 2>/dev/null || echo 0)
            echo "SSH Status:"
            echo "  Failed logins (1h): ${failed}"
            echo "  Successful logins (24h): ${logins}"
            echo "  Active sessions: $(who 2>/dev/null | wc -l)"
            ;;
        *)
            echo "Usage: ${0} {check|audit|full|status}"
            exit 1
            ;;
    esac
}

main "${@}"
