#!/bin/bash
# Linux Security Monitor - File Integrity Monitor Module

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

MODULE="INTEGRITY"

DEFAULT_WATCH_FILES=(
    "/etc/passwd"
    "/etc/shadow"
    "/etc/group"
    "/etc/gshadow"
    "/etc/sudoers"
    "/etc/ssh/sshd_config"
    "/etc/ssh/ssh_config"
    "/etc/crontab"
    "/etc/hosts"
    "/etc/hosts.allow"
    "/etc/hosts.deny"
    "/etc/fstab"
    "/etc/ld.so.conf"
    "/etc/ld.so.preload"
    "/etc/profile"
    "/etc/bashrc"
    "/etc/environment"
    "/boot/grub/grub.cfg"
    "/etc/pam.d/common-auth"
    "/etc/pam.d/sshd"
    "/etc/securetty"
    "/etc/resolv.conf"
    "/etc/nsswitch.conf"
    "/etc/modules"
)

DEFAULT_WATCH_DIRS=(
    "/etc/ssh"
    "/etc/cron.d"
    "/etc/cron.daily"
    "/etc/cron.hourly"
    "/etc/cron.weekly"
    "/etc/sudoers.d"
    "/etc/pam.d"
    "/etc/profile.d"
    "/etc/init.d"
    "/etc/systemd/system"
    "/root/.ssh"
    "/etc/apt/sources.list.d"
)

# ============================================================
# HASH COMPUTATION
# ============================================================
compute_hash() {
    local filepath="${1}"
    local algo="${INTEGRITY_HASH_ALGO:-sha256}"

    [[ -f "${filepath}" ]] || { echo "FILE_NOT_FOUND"; return 1; }

    case "${algo}" in
        sha256) sha256sum "${filepath}" 2>/dev/null | awk '{print $1}' ;;
        sha512) sha512sum "${filepath}" 2>/dev/null | awk '{print $1}' ;;
        md5)    md5sum    "${filepath}" 2>/dev/null | awk '{print $1}' ;;
        *)      sha256sum "${filepath}" 2>/dev/null | awk '{print $1}' ;;
    esac
}

get_file_metadata() {
    local filepath="${1}"
    if [[ -f "${filepath}" ]]; then
        stat -c '%A %U:%G %s' "${filepath}" 2>/dev/null || echo "--- unknown 0"
    else
        echo "--- unknown 0"
    fi
}

# ============================================================
# BASELINE MANAGEMENT
# ============================================================
create_baseline() {
    log_info "Creating integrity baseline..." "${MODULE}"

    local files=()
    # Parse configured paths from config
    if [[ -n "${INTEGRITY_PATHS:-}" ]]; then
        read -ra files <<< "${INTEGRITY_PATHS}"
    else
        files=("${DEFAULT_WATCH_FILES[@]}")
    fi

    # Add directory files
    local dirs=()
    if [[ -n "${INTEGRITY_DIRS:-}" ]]; then
        read -ra dirs <<< "${INTEGRITY_DIRS}"
    else
        dirs=("${DEFAULT_WATCH_DIRS[@]}")
    fi

    for dir in "${dirs[@]}"; do
        [[ -d "${dir}" ]] || continue
        while IFS= read -r -d '' file; do
            files+=("${file}")
        done < <(find "${dir}" -type f -maxdepth 2 -print0 2>/dev/null)
    done

    local count=0
    for filepath in "${files[@]}"; do
        [[ -f "${filepath}" ]] || continue

        local hash
        hash=$(compute_hash "${filepath}") || continue
        local meta
        meta=$(get_file_metadata "${filepath}")
        local perms owner size
        perms=$(echo "${meta}" | awk '{print $1}')
        owner=$(echo "${meta}" | awk '{print $2}')
        size=$(echo "${meta}" | awk '{print $3}')

        local escaped_path
        escaped_path=$(escape_sql "${filepath}")
        local escaped_hash
        escaped_hash=$(escape_sql "${hash}")

        db_exec "INSERT OR REPLACE INTO integrity_baseline (filepath, hash, permissions, owner, size)
                 VALUES ('${escaped_path}', '${escaped_hash}', '${perms}', '${owner}', ${size});"

        (( count++ ))
    done

    log_info "Baseline created with ${count} files" "${MODULE}"
    echo "Baseline created: ${count} files monitored"
}

export_baseline() {
    local export_file="${1:-${LSM_DATA_DIR}/integrity_baseline_export.txt}"
    db_exec ".headers on
             .mode csv
             SELECT filepath, hash, permissions, owner, size FROM integrity_baseline ORDER BY filepath;" \
        > "${export_file}"
    log_info "Baseline exported to ${export_file}" "${MODULE}"
}

# ============================================================
# INTEGRITY CHECK
# ============================================================
check_integrity() {
    [[ "${ENABLE_INTEGRITY_MONITOR}" != "true" ]] && return 0
    log_debug "Running integrity check" "${MODULE}"

    # Check if baseline exists
    local baseline_count
    baseline_count=$(db_exec "SELECT COUNT(*) FROM integrity_baseline;" 2>/dev/null || echo 0)

    if [[ "${baseline_count}" == "0" ]]; then
        log_info "No baseline found, creating initial baseline..." "${MODULE}"
        create_baseline
        return 0
    fi

    local changes=0

    # Check each file in baseline
    while IFS='|' read -r filepath stored_hash stored_perms stored_owner; do
        [[ -z "${filepath}" ]] && continue

        # File deleted
        if [[ ! -f "${filepath}" ]]; then
            local recent
            recent=$(db_exec "SELECT COUNT(*) FROM events WHERE module='INTEGRITY' AND description LIKE '%${filepath}%' AND event_type='FILE_DELETED' AND timestamp > strftime('%s','now','-1 hour');" 2>/dev/null || echo 0)

            if [[ "${recent}" == "0" ]]; then
                db_insert_event "INTEGRITY" "FILE_DELETED" 4 \
                    "Arquivo crítico deletado: ${filepath}" \
                    "Arquivo estava no baseline de integridade" \
                    "" "" ${RISK_WEIGHT_INTEGRITY:-25}

                db_exec "INSERT INTO integrity_changes (filepath, change_type, old_hash)
                         VALUES ('${filepath//\'/\'\'}', 'DELETED', '${stored_hash//\'/\'\'}');"

                send_telegram "CRITICAL" "Arquivo Crítico Deletado" \
"⛔ ARQUIVO CRÍTICO REMOVIDO
📄 Arquivo: \`${filepath}\`
📌 Isso pode indicar comprometimento do sistema!"

                log_critical "Critical file deleted: ${filepath}" "${MODULE}"
                (( changes++ ))
            fi
            continue
        fi

        # Compute current hash
        local current_hash
        current_hash=$(compute_hash "${filepath}") || continue

        # Hash changed
        if [[ "${current_hash}" != "${stored_hash}" ]]; then
            local recent
            recent=$(db_exec "SELECT COUNT(*) FROM events WHERE module='INTEGRITY' AND description LIKE '%${filepath}%' AND event_type='FILE_MODIFIED' AND timestamp > strftime('%s','now','-1 hour');" 2>/dev/null || echo 0)

            if [[ "${recent}" == "0" ]]; then
                db_insert_event "INTEGRITY" "FILE_MODIFIED" 4 \
                    "Arquivo crítico modificado: ${filepath}" \
                    "Hash alterado - Possível comprometimento" \
                    "" "" ${RISK_WEIGHT_INTEGRITY:-25}

                db_exec "INSERT INTO integrity_changes (filepath, change_type, old_hash, new_hash)
                         VALUES ('${filepath//\'/\'\'}', 'MODIFIED', '${stored_hash//\'/\'\'}', '${current_hash//\'/\'\'}');"

                # Update baseline
                db_exec "UPDATE integrity_baseline SET hash='${current_hash//\'/\'\'}', updated_at=strftime('%s','now')
                         WHERE filepath='${filepath//\'/\'\'}';"

                send_telegram "CRITICAL" "Arquivo Crítico Modificado" \
"⛔ MODIFICAÇÃO DETECTADA
📄 Arquivo: \`${filepath}\`
🔐 Hash anterior: \`${stored_hash:0:16}...\`
🔐 Hash atual:    \`${current_hash:0:16}...\`
📌 VERIFIQUE IMEDIATAMENTE"

                log_critical "Critical file modified: ${filepath}" "${MODULE}"
                (( changes++ ))
            fi
        fi

        # Permissions changed
        local current_meta
        current_meta=$(get_file_metadata "${filepath}")
        local current_perms current_owner
        current_perms=$(echo "${current_meta}" | awk '{print $1}')
        current_owner=$(echo "${current_meta}" | awk '{print $2}')

        if [[ "${current_perms}" != "${stored_perms}" ]]; then
            db_insert_event "INTEGRITY" "PERMS_CHANGED" 3 \
                "Permissões alteradas: ${filepath}" \
                "De: ${stored_perms} Para: ${current_perms}" \
                "" "" 15

            db_exec "INSERT INTO integrity_changes (filepath, change_type, old_perms, new_perms)
                     VALUES ('${filepath//\'/\'\'}', 'PERMS_CHANGED', '${stored_perms}', '${current_perms}');"

            db_exec "UPDATE integrity_baseline SET permissions='${current_perms}', updated_at=strftime('%s','now')
                     WHERE filepath='${filepath//\'/\'\'}';"

            log_warning "Permissions changed: ${filepath} (${stored_perms} -> ${current_perms})" "${MODULE}"
            (( changes++ ))
        fi

        if [[ "${current_owner}" != "${stored_owner}" ]]; then
            db_insert_event "INTEGRITY" "OWNER_CHANGED" 3 \
                "Proprietário alterado: ${filepath}" \
                "De: ${stored_owner} Para: ${current_owner}" \
                "" "" 15

            db_exec "UPDATE integrity_baseline SET owner='${current_owner}', updated_at=strftime('%s','now')
                     WHERE filepath='${filepath//\'/\'\'}';"

            log_warning "Owner changed: ${filepath} (${stored_owner} -> ${current_owner})" "${MODULE}"
            (( changes++ ))
        fi
    done < <(db_exec "SELECT filepath, hash, permissions, owner FROM integrity_baseline;" | tr '|' '|')

    # Also check for new SUID binaries in system paths
    check_suid_changes

    if [[ ${changes} -gt 0 ]]; then
        log_warning "Integrity check completed: ${changes} change(s) detected" "${MODULE}"
    else
        log_debug "Integrity check passed: no changes detected" "${MODULE}"
    fi

    db_insert_metric "integrity_changes" "${changes}" "count" ""
}

check_suid_changes() {
    local suid_snapshot="${LSM_DATA_DIR}/suid_system_snapshot.txt"
    local current_suid
    current_suid=$(find /bin /sbin /usr/bin /usr/sbin -perm /4000 -type f 2>/dev/null | sort)

    if [[ -f "${suid_snapshot}" ]]; then
        local prev_suid
        prev_suid=$(cat "${suid_snapshot}")

        while read -r new_file; do
            [[ -z "${new_file}" ]] && continue
            if ! echo "${prev_suid}" | grep -qx "${new_file}"; then
                db_insert_event "INTEGRITY" "NEW_SUID_BINARY" 4 \
                    "Novo binário SUID no sistema: ${new_file}" \
                    "Binário SUID não estava no baseline" "" "" 30

                send_telegram "CRITICAL" "Novo Binário SUID" \
"⛔ NOVO SUID NO SISTEMA
📄 Arquivo: \`${new_file}\`
📌 Possível escalação de privilégios!"

                log_critical "New SUID binary: ${new_file}" "${MODULE}"
            fi
        done < <(echo "${current_suid}")
    fi

    echo "${current_suid}" > "${suid_snapshot}"
}

# ============================================================
# PRELOAD ATTACK DETECTION
# ============================================================
check_ld_preload() {
    log_debug "Checking for LD_PRELOAD attacks" "${MODULE}"

    # Check /etc/ld.so.preload
    if [[ -f /etc/ld.so.preload ]] && [[ -s /etc/ld.so.preload ]]; then
        local preload_libs
        preload_libs=$(cat /etc/ld.so.preload)
        db_insert_event "INTEGRITY" "LD_PRELOAD_SET" 4 \
            "LD_PRELOAD configurado em /etc/ld.so.preload" \
            "Bibliotecas: ${preload_libs}" "" "" 40

        send_telegram "CRITICAL" "Possível Rootkit via LD_PRELOAD" \
"⛔ /etc/ld.so.preload está configurado!
📚 Bibliotecas: ${preload_libs}
📌 Possível tentativa de rootkit!"

        log_critical "LD_PRELOAD configured: ${preload_libs}" "${MODULE}"
    fi

    # Check for LD_PRELOAD in running processes
    for pid in /proc/[0-9]*/; do
        local pid_num
        pid_num=$(basename "${pid}")
        local environ
        environ=$(cat "${pid}environ" 2>/dev/null | tr '\0' '\n' | grep "^LD_PRELOAD" || true)

        if [[ -n "${environ}" ]]; then
            local cmd
            cmd=$(cat "${pid}cmdline" 2>/dev/null | tr '\0' ' ' | head -c 80 || echo "unknown")

            db_insert_event "INTEGRITY" "LD_PRELOAD_PROC" 3 \
                "Processo com LD_PRELOAD: PID ${pid_num}" \
                "Comando: ${cmd}\n${environ}" "" "" 20

            log_warning "Process ${pid_num} has LD_PRELOAD set: ${environ}" "${MODULE}"
        fi
    done
}

# ============================================================
# REPORT
# ============================================================
generate_integrity_report() {
    local report_file="${LSM_DATA_DIR}/reports/integrity_$(date +%Y%m%d_%H%M%S).txt"
    mkdir -p "$(dirname "${report_file}")"

    local baseline_count recent_changes all_changes
    baseline_count=$(db_exec 'SELECT COUNT(*) FROM integrity_baseline;' 2>/dev/null || echo 0)
    recent_changes=$(db_exec "SELECT datetime(timestamp,'unixepoch','localtime'), event_type, title FROM events WHERE module='INTEGRITY' AND timestamp > strftime('%s','now','-24 hours') ORDER BY timestamp DESC;" 2>/dev/null || true)
    all_changes=$(db_exec "SELECT datetime(timestamp,'unixepoch','localtime'), filepath, change_type FROM integrity_changes ORDER BY timestamp DESC LIMIT 50;" 2>/dev/null || true)

    printf '%s\n' \
        "==================================" \
        " Integrity Report" \
        " Generated: $(date)" \
        "==================================" \
        "" \
        "Files in baseline: ${baseline_count}" \
        "" \
        "Recent Changes (last 24h):" \
        "${recent_changes}" \
        "" \
        "All Integrity Changes:" \
        "${all_changes}" \
        > "${report_file}"

    echo "${report_file}"
}

# ============================================================
# MAIN
# ============================================================
main() {
    lsm_init

    case "${1:-check}" in
        check)
            check_integrity
            ;;
        baseline)
            create_baseline
            ;;
        export)
            export_baseline "${2:-}"
            ;;
        suid)
            check_suid_changes
            ;;
        preload)
            check_ld_preload
            ;;
        report)
            generate_integrity_report
            ;;
        status)
            local baseline_cnt changes_cnt last_check
            baseline_cnt=$(db_exec 'SELECT COUNT(*) FROM integrity_baseline;' 2>/dev/null || echo 0)
            changes_cnt=$(db_exec "SELECT COUNT(*) FROM events WHERE module='INTEGRITY' AND timestamp > strftime('%s','now','-24 hours');" 2>/dev/null || echo 0)
            last_check=$(db_exec "SELECT datetime(MAX(timestamp),'unixepoch','localtime') FROM events WHERE module='INTEGRITY';" 2>/dev/null || echo "never")
            echo "Integrity Status:"
            echo "  Files in baseline: ${baseline_cnt}"
            echo "  Changes (24h): ${changes_cnt}"
            echo "  Last check: ${last_check}"
            ;;
        *)
            echo "Usage: ${0} {check|baseline|export|suid|preload|report|status}"
            exit 1
            ;;
    esac
}

main "${@}"
