#!/bin/bash
# Linux Security Monitor - Process Monitor Module

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

MODULE="PROCESS"

# ============================================================
# SUSPICIOUS PROCESS PATTERNS
# ============================================================
SUSPICIOUS_NAMES=(
    "ncat" "netcat" "nc.traditional"
    "msfconsole" "meterpreter" "metasploit"
    "hydra" "medusa" "nmap" "masscan"
    "tcpdump" "wireshark" "tshark"
    "cryptominer" "xmrig" "minerd" "cpuminer"
    "c3" "cobalt" "beacon"
    "mimikatz" "lazagne"
    "reverse_shell" "bind_shell"
)

SUSPICIOUS_PATTERNS=(
    "base64 -d.*bash"
    "bash -i.*>/dev/tcp"
    "python.*-c.*import socket"
    "perl.*socket"
    "ruby.*TCPSocket"
    "php.*fsockopen"
    "nc.*-e.*bash"
    "curl.*sh|wget.*sh"
    "mkfifo.*bash"
    "exec.*>&"
    "/dev/tcp/"
    "chmod.*777"
    "chmod.*\+s"
)

# ============================================================
# PROCESS SNAPSHOT
# ============================================================
get_process_snapshot() {
    ps aux --no-headers 2>/dev/null | awk '{print $2":"$1":"$3":"$4":"$11}' | sort
}

save_process_snapshot() {
    get_process_snapshot > "${LSM_DATA_DIR}/process_snapshot.txt"
}

# ============================================================
# HIGH RESOURCE DETECTION
# ============================================================
check_high_resource_processes() {
    log_debug "Checking for high resource processes" "${MODULE}"

    local cpu_threshold="${PROCESS_CPU_THRESHOLD:-90}"
    local mem_threshold="${PROCESS_MEM_THRESHOLD:-80}"

    while read -r line; do
        local pid user cpu mem cmd
        pid=$(echo "${line}" | awk '{print $1}')
        user=$(echo "${line}" | awk '{print $2}')
        cpu=$(echo "${line}" | awk '{print $3}')
        mem=$(echo "${line}" | awk '{print $4}')
        cmd=$(echo "${line}" | awk '{print $11}')

        # High CPU
        if (( $(echo "${cpu} > ${cpu_threshold}" | bc -l 2>/dev/null || echo 0) )); then
            local recent
            recent=$(db_exec "SELECT COUNT(*) FROM events WHERE module='PROCESS' AND event_type='HIGH_CPU_PROC' AND process='${cmd}' AND timestamp > strftime('%s','now','-5 minutes');" 2>/dev/null || echo 0)

            if [[ "${recent}" == "0" ]]; then
                db_insert_event "PROCESS" "HIGH_CPU_PROC" 3 "Processo com alto CPU: ${cmd}" \
                    "PID ${pid} (${user}): CPU=${cpu}% MEM=${mem}%" "" "${user}" 10

                send_telegram "WARNING" "Processo com Alto CPU" \
"🔧 Processo: \`${cmd}\`
🔢 PID: ${pid}
👤 Usuário: ${user}
📊 CPU: ${cpu}%"

                log_warning "High CPU process: ${cmd} (PID:${pid} CPU:${cpu}%)" "${MODULE}"
            fi
        fi

        # High Memory
        if (( $(echo "${mem} > ${mem_threshold}" | bc -l 2>/dev/null || echo 0) )); then
            local recent
            recent=$(db_exec "SELECT COUNT(*) FROM events WHERE module='PROCESS' AND event_type='HIGH_MEM_PROC' AND process='${cmd}' AND timestamp > strftime('%s','now','-10 minutes');" 2>/dev/null || echo 0)

            if [[ "${recent}" == "0" ]]; then
                db_insert_event "PROCESS" "HIGH_MEM_PROC" 2 "Processo com alto uso de memória: ${cmd}" \
                    "PID ${pid} (${user}): MEM=${mem}%" "" "${user}" 5

                log_warning "High memory process: ${cmd} (PID:${pid} MEM:${mem}%)" "${MODULE}"
            fi
        fi
    done < <(ps aux --no-headers 2>/dev/null | tail -n +2)
}

# ============================================================
# SUSPICIOUS PROCESS DETECTION
# ============================================================
check_suspicious_processes() {
    log_debug "Checking for suspicious processes" "${MODULE}"

    local ps_output
    ps_output=$(ps auxww 2>/dev/null || true)

    # Check suspicious names
    for name in "${SUSPICIOUS_NAMES[@]}"; do
        if echo "${ps_output}" | grep -qiE "(^|\s)${name}(\s|$)"; then
            local proc_line
            proc_line=$(echo "${ps_output}" | grep -iE "(^|\s)${name}(\s|$)" | head -1)
            local pid user
            pid=$(echo "${proc_line}" | awk '{print $2}')
            user=$(echo "${proc_line}" | awk '{print $1}')

            local recent
            recent=$(db_exec "SELECT COUNT(*) FROM events WHERE module='PROCESS' AND event_type='SUSPICIOUS_PROC' AND process='${name}' AND timestamp > strftime('%s','now','-30 minutes');" 2>/dev/null || echo 0)

            if [[ "${recent}" == "0" ]]; then
                db_insert_event "PROCESS" "SUSPICIOUS_PROC" 4 "Processo suspeito detectado: ${name}" \
                    "PID ${pid}, usuário: ${user}" "" "${user}" ${RISK_WEIGHT_SUSPICIOUS_PROCESS:-20}

                send_telegram "CRITICAL" "Processo Suspeito Detectado" \
"⛔ Processo: \`${name}\`
🔢 PID: ${pid}
👤 Usuário: ${user}
📌 Investigar imediatamente!"

                log_critical "Suspicious process detected: ${name} (PID: ${pid}, user: ${user})" "${MODULE}"
            fi
        fi
    done

    # Check suspicious command patterns
    for pattern in "${SUSPICIOUS_PATTERNS[@]}"; do
        if echo "${ps_output}" | grep -qE "${pattern}"; then
            local proc_line
            proc_line=$(echo "${ps_output}" | grep -E "${pattern}" | head -1)
            local pid user cmd
            pid=$(echo "${proc_line}" | awk '{print $2}')
            user=$(echo "${proc_line}" | awk '{print $1}')
            cmd=$(echo "${proc_line}" | awk '{print $11}')

            local recent
            recent=$(db_exec "SELECT COUNT(*) FROM events WHERE module='PROCESS' AND event_type='MALICIOUS_PATTERN' AND timestamp > strftime('%s','now','-15 minutes');" 2>/dev/null || echo 0)

            if [[ "${recent}" == "0" ]]; then
                db_insert_event "PROCESS" "MALICIOUS_PATTERN" 4 "Padrão malicioso em processo" \
                    "Pattern: ${pattern}\nPID: ${pid}, Usuário: ${user}" "" "${user}" 30

                send_telegram "CRITICAL" "Padrão Malicioso em Processo" \
"⛔ CRÍTICO: Padrão suspeito detectado
🔧 Padrão: \`${pattern}\`
🔢 PID: ${pid}
👤 Usuário: ${user}
📌 Possível backdoor ou shell reverso!"

                log_critical "Malicious pattern in process: ${pattern} (PID: ${pid})" "${MODULE}"
            fi
        fi
    done
}

# ============================================================
# HIDDEN PROCESS DETECTION
# ============================================================
check_hidden_processes() {
    log_debug "Checking for hidden processes" "${MODULE}"

    # Compare /proc with ps output
    local proc_pids
    proc_pids=$(ls /proc 2>/dev/null | grep -E '^[0-9]+$' | sort -n)
    local ps_pids
    ps_pids=$(ps aux --no-headers 2>/dev/null | awk '{print $2}' | sort -n)

    # PIDs in /proc but not in ps
    for pid in ${proc_pids}; do
        if [[ -d "/proc/${pid}" ]] && ! echo "${ps_pids}" | grep -qx "${pid}"; then
            local cmdline
            cmdline=$(cat "/proc/${pid}/cmdline" 2>/dev/null | tr '\0' ' ' | head -c 100 || echo "unknown")
            [[ -z "${cmdline}" ]] && continue

            db_insert_event "PROCESS" "HIDDEN_PROCESS" 4 "Processo oculto detectado: PID ${pid}" \
                "Processo em /proc mas não visível no ps: ${cmdline}" "" "" 40

            send_telegram "CRITICAL" "Processo Oculto Detectado" \
"⛔ PID ${pid} está oculto!
🔧 Comando: \`${cmdline}\`
📌 Possível rootkit instalado!"

            log_critical "Hidden process detected: PID ${pid} (${cmdline})" "${MODULE}"
        fi
    done
}

# ============================================================
# CRYPTOMINER DETECTION
# ============================================================
check_cryptominers() {
    log_debug "Checking for cryptominers" "${MODULE}"

    # High CPU + network + unknown binary
    local high_cpu_procs
    high_cpu_procs=$(ps aux --no-headers 2>/dev/null | awk '$3 > 70 {print $1":"$2":"$3":"$11}' || true)

    while read -r line; do
        [[ -z "${line}" ]] && continue
        local user pid cpu cmd
        user=$(echo "${line}" | cut -d: -f1)
        pid=$(echo "${line}" | cut -d: -f2)
        cpu=$(echo "${line}" | cut -d: -f3)
        cmd=$(echo "${line}" | cut -d: -f4)

        # Check if process has network connections (miners need pool connections)
        if [[ -n "${pid}" ]] && ss -tnp 2>/dev/null | grep -q "pid=${pid}"; then
            # Check against known miner ports
            local connections
            connections=$(ss -tnp 2>/dev/null | grep "pid=${pid}" | grep -E ":3333|:4444|:5555|:7777|:9999|:14444|:14433|:45700" || true)

            if [[ -n "${connections}" ]]; then
                db_insert_event "PROCESS" "CRYPTOMINER" 4 "Possível cryptominer: ${cmd} (PID:${pid})" \
                    "CPU: ${cpu}%, conexões em portas de pool de mineração" "" "${user}" 50

                send_telegram "CRITICAL" "Cryptominer Detectado" \
"⛔ Possível cryptominer em execução!
🔧 Processo: \`${cmd}\`
🔢 PID: ${pid}
👤 Usuário: ${user}
📊 CPU: ${cpu}%
📌 AÇÃO IMEDIATA NECESSÁRIA"

                log_critical "Cryptominer detected: ${cmd} (PID: ${pid}, CPU: ${cpu}%)" "${MODULE}"
            fi
        fi
    done < <(echo "${high_cpu_procs}")
}

# ============================================================
# SUID PROCESS DETECTION
# ============================================================
check_suid_processes() {
    log_debug "Checking SUID processes" "${MODULE}"

    local suid_snapshot="${LSM_DATA_DIR}/suid_snapshot.txt"
    local current_suid
    current_suid=$(find / -perm /4000 -type f 2>/dev/null | sort)

    if [[ -f "${suid_snapshot}" ]]; then
        local prev_suid
        prev_suid=$(cat "${suid_snapshot}")

        while read -r new_file; do
            if ! echo "${prev_suid}" | grep -qx "${new_file}"; then
                local owner perms
                owner=$(stat -c '%U' "${new_file}" 2>/dev/null || echo "unknown")
                perms=$(stat -c '%A' "${new_file}" 2>/dev/null || echo "unknown")

                db_insert_event "PROCESS" "NEW_SUID_FILE" 3 "Novo arquivo SUID: ${new_file}" \
                    "Owner: ${owner}, Permissions: ${perms}" "" "" 20

                send_telegram "WARNING" "Novo Arquivo SUID Detectado" \
"📄 Arquivo: \`${new_file}\`
👤 Dono: ${owner}
🔐 Permissões: ${perms}
📌 Verifique se foi autorizado"

                log_warning "New SUID file: ${new_file} (owner: ${owner})" "${MODULE}"
            fi
        done < <(echo "${current_suid}")
    fi

    echo "${current_suid}" > "${suid_snapshot}"
}

# ============================================================
# MAIN
# ============================================================
main() {
    lsm_init

    case "${1:-check}" in
        check)
            check_high_resource_processes
            check_suspicious_processes
            ;;
        deep)
            check_high_resource_processes
            check_suspicious_processes
            check_hidden_processes
            check_cryptominers
            check_suid_processes
            ;;
        miners)
            check_cryptominers
            ;;
        hidden)
            check_hidden_processes
            ;;
        suid)
            check_suid_processes
            ;;
        status)
            echo "Process Status:"
            echo "  Total processes: $(ps aux --no-headers | wc -l)"
            echo "  Running as root: $(ps aux --no-headers | awk '$1=="root"' | wc -l)"
            echo "  High CPU (>80%): $(ps aux --no-headers | awk '$3>80' | wc -l)"
            ;;
        *)
            echo "Usage: ${0} {check|deep|miners|hidden|suid|status}"
            exit 1
            ;;
    esac
}

main "${@}"
