#!/bin/bash
# Linux Security Monitor - User & Permission Monitor Module

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

MODULE="USERS"

# ============================================================
# USER SNAPSHOTS
# ============================================================
get_user_snapshot() {
    # Format: username:uid:gid:groups:shell:home
    while IFS=: read -r user _ uid gid _ home shell; do
        [[ ${uid} -lt 1000 && ${uid} -ne 0 ]] && continue  # Skip system users (but keep root)
        local groups
        groups=$(id "${user}" 2>/dev/null | grep -oP 'groups=\K.*' | sed 's/[0-9]*(\([^)]*\))/\1/g' || echo "unknown")
        echo "${user}:${uid}:${gid}:${groups}:${shell}:${home}"
    done < /etc/passwd
}

save_user_snapshot() {
    get_user_snapshot > "${LSM_DATA_DIR}/users_snapshot.txt"
}

load_user_snapshot() {
    local snapshot_file="${LSM_DATA_DIR}/users_snapshot.txt"
    [[ -f "${snapshot_file}" ]] && cat "${snapshot_file}" || true
}

# ============================================================
# USER CHANGE DETECTION
# ============================================================
check_user_changes() {
    log_debug "Checking user account changes" "${MODULE}"

    local prev_snapshot
    prev_snapshot=$(load_user_snapshot)
    local curr_snapshot
    curr_snapshot=$(get_user_snapshot)

    if [[ -z "${prev_snapshot}" ]]; then
        save_user_snapshot
        log_info "User snapshot initialized" "${MODULE}"
        return 0
    fi

    # New users
    while read -r curr_line; do
        local username
        username=$(echo "${curr_line}" | cut -d: -f1)
        if ! echo "${prev_snapshot}" | grep -q "^${username}:"; then
            local uid shell
            uid=$(echo "${curr_line}" | cut -d: -f2)
            shell=$(echo "${curr_line}" | cut -d: -f5)

            # Determine who added the user (check auth log)
            local added_by
            added_by=$(grep "useradd\|adduser" /var/log/auth.log 2>/dev/null | \
                       grep "${username}" | tail -1 | grep -oP '(?<=\s)\w+(?=\s*:)' || echo "unknown")

            local severity=2
            local risk=${RISK_WEIGHT_NEW_USER:-15}

            # Root-level UID is critical
            if [[ "${uid}" == "0" ]]; then
                severity=4
                risk=50
                db_insert_event "USERS" "ROOT_USER_CREATED" 4 "Usuário com UID 0 criado: ${username}" \
                    "CRÍTICO: Novo usuário root equivalente criado" "" "${username}" "${risk}"

                send_telegram "CRITICAL" "Usuário Root Criado" \
"⛔ CRÍTICO: Novo usuário com UID 0
👤 Usuário: \`${username}\`
📌 Acesso root equivalente criado!"
                log_critical "New UID 0 user created: ${username}" "${MODULE}"
            else
                db_insert_event "USERS" "USER_CREATED" ${severity} "Novo usuário criado: ${username}" \
                    "Usuário ${username} (UID:${uid}) criado por ${added_by}" \
                    "" "${username}" "${risk}"

                send_telegram "WARNING" "Novo Usuário Criado" \
"👤 Usuário: \`${username}\`
🔢 UID: ${uid}
🐚 Shell: ${shell}
👮 Criado por: ${added_by}"

                log_warning "New user created: ${username} (UID: ${uid})" "${MODULE}"
            fi
        fi
    done < <(echo "${curr_snapshot}")

    # Deleted users
    while read -r prev_line; do
        local username
        username=$(echo "${prev_line}" | cut -d: -f1)
        if ! echo "${curr_snapshot}" | grep -q "^${username}:"; then
            db_insert_event "USERS" "USER_DELETED" 2 "Usuário removido: ${username}" \
                "Conta de usuário ${username} foi deletada" "" "${username}" 5

            send_telegram "WARNING" "Usuário Removido" \
"👤 Usuário: \`${username}\`
⚠️ Conta foi deletada do sistema"

            log_warning "User deleted: ${username}" "${MODULE}"
        fi
    done < <(echo "${prev_snapshot}")

    # Changed users (groups, shell, etc.)
    while read -r curr_line; do
        local username
        username=$(echo "${curr_line}" | cut -d: -f1)
        local prev_line
        prev_line=$(echo "${prev_snapshot}" | grep "^${username}:" || true)

        [[ -z "${prev_line}" ]] && continue
        [[ "${curr_line}" == "${prev_line}" ]] && continue

        local prev_groups curr_groups prev_shell curr_shell
        prev_groups=$(echo "${prev_line}" | cut -d: -f4)
        curr_groups=$(echo "${curr_line}" | cut -d: -f4)
        prev_shell=$(echo "${prev_line}" | cut -d: -f5)
        curr_shell=$(echo "${curr_line}" | cut -d: -f5)

        if [[ "${prev_groups}" != "${curr_groups}" ]]; then
            local severity=2
            local risk=10

            # Check if added to sudo/admin group
            if echo "${curr_groups}" | grep -qE "sudo|wheel|admin"; then
                if ! echo "${prev_groups}" | grep -qE "sudo|wheel|admin"; then
                    severity=3
                    risk=20
                    db_insert_event "USERS" "SUDO_GROUP_ADDED" ${severity} \
                        "Usuário ${username} adicionado ao grupo sudo" \
                        "Grupos anteriores: ${prev_groups}\nGrupos atuais: ${curr_groups}" \
                        "" "${username}" "${risk}"

                    send_telegram "WARNING" "Usuário Ganhou Privilégios Sudo" \
"👤 Usuário: \`${username}\`
🔑 Adicionado ao grupo sudo/admin
⚠️ Verifique se isso foi autorizado"

                    log_warning "User ${username} added to sudo group" "${MODULE}"
                fi
            else
                db_insert_event "USERS" "USER_GROUPS_CHANGED" ${severity} \
                    "Grupos de ${username} alterados" \
                    "De: ${prev_groups}\nPara: ${curr_groups}" \
                    "" "${username}" "${risk}"
                log_warning "User ${username} groups changed" "${MODULE}"
            fi
        fi

        if [[ "${prev_shell}" != "${curr_shell}" ]]; then
            db_insert_event "USERS" "USER_SHELL_CHANGED" 2 \
                "Shell de ${username} alterado" \
                "De: ${prev_shell}\nPara: ${curr_shell}" \
                "" "${username}" 5
            log_warning "User ${username} shell changed from ${prev_shell} to ${curr_shell}" "${MODULE}"
        fi
    done < <(echo "${curr_snapshot}")

    save_user_snapshot
}

# ============================================================
# SUDO MONITORING
# ============================================================
check_sudo_usage() {
    log_debug "Checking sudo usage" "${MODULE}"

    local log_file
    log_file=$(get_ssh_log 2>/dev/null || echo "/var/log/auth.log")
    [[ "${log_file}" == "journald" ]] && log_file="/var/log/auth.log"
    [[ -f "${log_file}" ]] || return 0

    local pos_file="${LSM_DATA_DIR}/sudo_log_pos.txt"
    local last_pos=0
    [[ -f "${pos_file}" ]] && last_pos=$(cat "${pos_file}")
    local total_lines
    total_lines=$(wc -l < "${log_file}" 2>/dev/null || echo 0)

    if [[ ${total_lines} -gt ${last_pos} ]]; then
        while read -r line; do
            # Match sudo command execution
            if echo "${line}" | grep -qE "sudo:.*COMMAND="; then
                local sudo_user command tty
                sudo_user=$(echo "${line}" | grep -oP '(?<=sudo:\s{1,4})\w+' | head -1)
                command=$(echo "${line}" | grep -oP '(?<=COMMAND=).*' | head -1)
                tty=$(echo "${line}" | grep -oP '(?<=TTY=)\S+' | head -1)

                local severity=1
                local risk=${RISK_WEIGHT_SUDO:-5}

                # High risk commands
                if echo "${command}" | grep -qE "passwd|chmod 777|rm -rf|wget|curl.*sh|bash|sh -c|nc |ncat|python.*-c"; then
                    severity=3
                    risk=15
                fi

                # Extra critical
                if echo "${command}" | grep -qE "/bin/bash|/bin/sh|useradd|userdel|visudo|sudoers"; then
                    severity=4
                    risk=25
                    db_insert_event "USERS" "SUDO_CRITICAL" ${severity} \
                        "Comando sudo crítico: ${sudo_user}" \
                        "Comando: ${command}" "" "${sudo_user}" "${risk}"

                    send_telegram "WARNING" "Comando sudo Crítico" \
"👤 Usuário: \`${sudo_user}\`
💻 Comando: \`${command}\`
📌 Comando potencialmente perigoso"
                    log_warning "Critical sudo command by ${sudo_user}: ${command}" "${MODULE}"
                else
                    db_insert_event "USERS" "SUDO_COMMAND" ${severity} \
                        "Sudo executado por ${sudo_user}" \
                        "Comando: ${command}" "" "${sudo_user}" "${risk}"
                    log_info "Sudo command by ${sudo_user}: ${command}" "${MODULE}"
                fi
            fi

            # Failed sudo attempts
            if echo "${line}" | grep -qE "sudo:.*incorrect password|sudo:.*NOT in sudoers"; then
                local user
                user=$(echo "${line}" | grep -oP '(?<=sudo:\s{1,4})\w+' | head -1)

                db_insert_event "USERS" "SUDO_FAILED" 3 \
                    "Tentativa de sudo falhou: ${user}" \
                    "${line}" "" "${user}" 10

                log_warning "Failed sudo attempt by ${user}" "${MODULE}"
            fi
        done < <(tail -n +$(( last_pos + 1 )) "${log_file}" | grep -i sudo || true)

        echo "${total_lines}" > "${pos_file}"
    fi
}

# ============================================================
# PASSWORD POLICY CHECK
# ============================================================
check_password_policy() {
    log_debug "Checking password policy" "${MODULE}"

    # Check for accounts with no password
    while IFS=: read -r user passwd _; do
        if [[ "${passwd}" == "" || "${passwd}" == "!" || "${passwd}" == "*" ]]; then
            continue  # Locked accounts are fine
        fi
        if [[ "${passwd}" == "$(echo "${user}" | tr '[:upper:]' '[:lower:]')" ]]; then
            db_insert_event "USERS" "WEAK_PASSWORD" 4 "Senha fraca detectada: ${user}" \
                "Usuário tem senha idêntica ao nome de usuário" "" "${user}" 25
            log_critical "User ${user} has weak password" "${MODULE}"
        fi
    done < /etc/shadow 2>/dev/null || true

    # Check for accounts without password expiry
    if command_exists chage; then
        while IFS=: read -r user _ uid _ _ _ _ expiry _; do
            [[ ${uid} -lt 1000 ]] && continue
            [[ "${expiry}" == "99999" ]] && {
                log_debug "User ${user} has no password expiry set" "${MODULE}"
            }
        done < /etc/shadow 2>/dev/null || true
    fi

    # Check PAM password requirements
    local pam_common="/etc/pam.d/common-password"
    if [[ -f "${pam_common}" ]]; then
        if ! grep -q "pam_pwquality\|pam_cracklib" "${pam_common}"; then
            db_insert_event "USERS" "NO_PASSWORD_POLICY" 2 \
                "Política de senha fraca: pam_pwquality não configurado" \
                "Arquivo: ${pam_common}" "" "" 10
            log_warning "Password quality module not configured in PAM" "${MODULE}"
        fi
    fi
}

# ============================================================
# ROOT ACCOUNT SECURITY CHECK
# ============================================================
check_root_security() {
    log_debug "Checking root account security" "${MODULE}"

    # Check for multiple UID 0 accounts
    local root_users
    root_users=$(awk -F: '$3==0{print $1}' /etc/passwd 2>/dev/null)
    local root_count
    root_count=$(echo "${root_users}" | wc -l)

    if [[ ${root_count} -gt 1 ]]; then
        db_insert_event "USERS" "MULTIPLE_ROOT" 4 \
            "Múltiplas contas com UID 0: ${root_users}" \
            "Apenas a conta 'root' deve ter UID 0" "" "" 50

        send_telegram "CRITICAL" "Múltiplas Contas Root" \
"⛔ CRÍTICO: ${root_count} contas com UID 0
👥 Usuários: ${root_users}
📌 Apenas 'root' deve ter UID 0"

        log_critical "Multiple UID 0 accounts: ${root_users}" "${MODULE}"
    fi

    # Check .rhosts and .netrc
    for home_dir in /root /home/*/; do
        for insecure_file in .rhosts .netrc; do
            if [[ -f "${home_dir}/${insecure_file}" ]]; then
                db_insert_event "USERS" "INSECURE_FILE" 3 \
                    "Arquivo inseguro encontrado: ${home_dir}/${insecure_file}" \
                    "Arquivos .rhosts e .netrc representam riscos de segurança" "" "" 15
                log_warning "Insecure file found: ${home_dir}/${insecure_file}" "${MODULE}"
            fi
        done
    done

    # Check for SUID/SGID files in home directories
    local suid_files
    suid_files=$(find /home -perm /6000 -type f 2>/dev/null | head -10 || true)
    if [[ -n "${suid_files}" ]]; then
        db_insert_event "USERS" "SUID_IN_HOME" 3 \
            "Arquivos SUID/SGID encontrados em /home" \
            "${suid_files}" "" "" 20
        log_warning "SUID/SGID files in home directories: ${suid_files}" "${MODULE}"
    fi
}

# ============================================================
# MAIN
# ============================================================
main() {
    lsm_init

    case "${1:-check}" in
        check)
            check_user_changes
            check_sudo_usage
            ;;
        audit)
            check_password_policy
            check_root_security
            ;;
        full)
            check_user_changes
            check_sudo_usage
            check_password_policy
            check_root_security
            ;;
        status)
            echo "User Status:"
            echo "  Total users (uid>=1000): $(awk -F: '$3>=1000{print $1}' /etc/passwd | wc -l)"
            echo "  Sudo users: $(getent group sudo 2>/dev/null | cut -d: -f4 || getent group wheel 2>/dev/null | cut -d: -f4)"
            echo "  Logged in: $(who 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
            ;;
        *)
            echo "Usage: ${0} {check|audit|full|status}"
            exit 1
            ;;
    esac
}

main "${@}"
