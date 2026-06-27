#!/bin/bash
# Linux Security Monitor - Network Monitor Module

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

MODULE="NETWORK"

# ============================================================
# PORT SCAN DETECTION
# ============================================================
check_port_scan() {
    [[ "${ENABLE_NETWORK_MONITOR}" != "true" ]] && return 0
    log_debug "Checking for port scans" "${MODULE}"

    local threshold="${PORT_SCAN_THRESHOLD:-20}"
    local time_window=60  # seconds

    # Count connection attempts per IP (SYN packets to multiple ports)
    declare -A ip_port_counts

    # Parse netstat/ss for half-open connections
    while read -r line; do
        local ip
        ip=$(echo "${line}" | awk '{print $5}' | grep -oP '^\d+\.\d+\.\d+\.\d+')
        [[ -z "${ip}" ]] && continue
        is_private_ip "${ip}" && continue

        ip_port_counts["${ip}"]=$(( ${ip_port_counts["${ip}"]:-0} + 1 ))
    done < <(ss -tn 2>/dev/null | grep -v LISTEN || true)

    for ip in "${!ip_port_counts[@]}"; do
        local count="${ip_port_counts[${ip}]}"
        if [[ ${count} -ge ${threshold} ]]; then
            local recent
            recent=$(db_exec "SELECT COUNT(*) FROM events WHERE module='NETWORK' AND event_type='PORT_SCAN' AND source_ip='${ip}' AND timestamp > strftime('%s','now','-5 minutes');" 2>/dev/null || echo 0)

            if [[ "${recent}" == "0" ]]; then
                db_insert_event "NETWORK" "PORT_SCAN" 4 "Possível port scan de ${ip}" \
                    "${count} conexões simultâneas de ${ip}" "${ip}" "" ${RISK_WEIGHT_PORT_SCAN:-15}

                send_telegram "CRITICAL" "Possível Port Scan" \
"⛔ Port scan detectado!
🌍 IP: \`${ip}\`
🔢 Conexões: ${count}
📌 Verificar regras de firewall"

                log_critical "Possible port scan from ${ip}: ${count} connections" "${MODULE}"

                # Auto-block if fail2ban available
                if command_exists fail2ban-client; then
                    fail2ban-client set sshd banip "${ip}" 2>/dev/null || true
                fi
            fi
        fi
    done
}

# ============================================================
# SUSPICIOUS CONNECTIONS
# ============================================================
check_suspicious_connections() {
    log_debug "Checking suspicious network connections" "${MODULE}"

    # Suspicious destination ports (C2, common malware)
    local suspicious_ports=(
        "1080"   # SOCKS proxy
        "4444"   # Metasploit default
        "5555"   # Android ADB / RATs
        "6666"   # IRC (possible botnet)
        "6667"   # IRC
        "6668"   # IRC
        "6669"   # IRC
        "31337"  # Classic backdoor
        "12345"  # Common RAT
        "27374"  # SubSeven
        "65535"  # Common backdoor
    )

    while read -r line; do
        local dst_ip dst_port
        dst_ip=$(echo "${line}" | awk '{print $5}' | grep -oP '^\d+\.\d+\.\d+\.\d+')
        dst_port=$(echo "${line}" | awk '{print $5}' | grep -oP ':\K\d+$')

        [[ -z "${dst_ip}" || -z "${dst_port}" ]] && continue

        for sport in "${suspicious_ports[@]}"; do
            if [[ "${dst_port}" == "${sport}" ]]; then
                local local_prog
                local_prog=$(echo "${line}" | awk '{print $7}' | grep -oP '(?<=\().*(?=\))' || echo "unknown")

                db_insert_event "NETWORK" "SUSPICIOUS_CONNECTION" 3 \
                    "Conexão suspeita para porta ${sport}: ${dst_ip}" \
                    "Programa: ${local_prog}" "${dst_ip}" "" 20

                send_telegram "WARNING" "Conexão de Rede Suspeita" \
"⚠️ Conexão para porta suspeita
🌍 Destino: \`${dst_ip}:${dst_port}\`
🔧 Processo: ${local_prog}
📌 Verifique possível malware"

                log_warning "Suspicious connection to ${dst_ip}:${dst_port} by ${local_prog}" "${MODULE}"
                break
            fi
        done
    done < <(ss -tnp 2>/dev/null | grep ESTAB || true)

    # Check for connections to non-standard high ports in large numbers
    local unusual_conns
    unusual_conns=$(ss -tn 2>/dev/null | grep ESTAB | awk '{print $5}' | \
                    grep -oP ':\K\d+$' | awk '$1>1024 && $1<49152' | sort | uniq -c | sort -rn | head -5 || true)

    if [[ -n "${unusual_conns}" ]]; then
        log_debug "Outbound connections to high ports: ${unusual_conns}" "${MODULE}"
    fi
}

# ============================================================
# LISTENING SERVICES CHECK
# ============================================================
check_listening_services() {
    log_debug "Checking listening services" "${MODULE}"

    local services_file="${LSM_DATA_DIR}/listening_services.txt"
    local current_services
    current_services=$(ss -tlnp 2>/dev/null | awk 'NR>1{print $4":"$6}' | sort)

    if [[ -f "${services_file}" ]]; then
        local prev_services
        prev_services=$(cat "${services_file}")

        # New listening services
        while read -r new_svc; do
            [[ -z "${new_svc}" ]] && continue
            if ! echo "${prev_services}" | grep -qx "${new_svc}"; then
                local port addr prog
                addr=$(echo "${new_svc}" | cut -d: -f1)
                port=$(echo "${new_svc}" | cut -d: -f2 | cut -d: -f1)
                prog=$(echo "${new_svc}" | cut -d: -f2)

                # Public-facing services are higher severity
                local severity=1
                if [[ "${addr}" == "0.0.0.0" || "${addr}" == "*" || "${addr}" == "::" ]]; then
                    severity=2
                fi

                db_insert_event "NETWORK" "NEW_SERVICE" ${severity} \
                    "Novo serviço em escuta: porta ${port}" \
                    "Endereço: ${addr}, Processo: ${prog}" "" "" 10

                log_warning "New listening service on port ${port} (addr: ${addr})" "${MODULE}"
            fi
        done < <(echo "${current_services}")
    fi

    echo "${current_services}" > "${services_file}"
}

# ============================================================
# NETWORK BANDWIDTH MONITORING
# ============================================================
check_bandwidth() {
    log_debug "Checking network bandwidth" "${MODULE}"

    local iface_file="${LSM_DATA_DIR}/net_counters.txt"
    local timestamp
    timestamp=$(date +%s)

    declare -A rx_bytes tx_bytes

    # Read current counters
    while read -r iface rx tx; do
        [[ "${iface}" == "lo:" ]] && continue
        rx_bytes["${iface}"]="${rx}"
        tx_bytes["${iface}"]="${tx}"
    done < <(grep -E '^\s*[a-z]' /proc/net/dev 2>/dev/null | awk '{print $1, $2, $10}')

    if [[ -f "${iface_file}" ]]; then
        local prev_timestamp
        read -r prev_timestamp < "${iface_file}"
        local elapsed=$(( timestamp - prev_timestamp ))

        if [[ ${elapsed} -gt 0 ]]; then
            while IFS='|' read -r iface prev_rx prev_tx; do
                local curr_rx="${rx_bytes[${iface}]:-0}"
                local curr_tx="${tx_bytes[${iface}]:-0}"

                local rx_rate tx_rate
                rx_rate=$(( (curr_rx - prev_rx) / elapsed ))
                tx_rate=$(( (curr_tx - prev_tx) / elapsed ))

                # Store as KB/s
                db_insert_metric "net_rx_kbps" "$(( rx_rate / 1024 ))" "KB/s" "iface=${iface%:}"
                db_insert_metric "net_tx_kbps" "$(( tx_rate / 1024 ))" "KB/s" "iface=${iface%:}"

                # Alert on extremely high traffic (> 100 MB/s = unusual for VPS)
                local threshold_bps=$(( 100 * 1024 * 1024 ))
                if [[ ${rx_rate} -gt ${threshold_bps} || ${tx_rate} -gt ${threshold_bps} ]]; then
                    db_insert_event "NETWORK" "HIGH_BANDWIDTH" 2 \
                        "Alto tráfego de rede: ${iface%:}" \
                        "RX: $(( rx_rate / 1024 / 1024 )) MB/s, TX: $(( tx_rate / 1024 / 1024 )) MB/s" \
                        "" "" 10
                    log_warning "High bandwidth on ${iface%:}: RX=$(( rx_rate / 1024 ))KB/s TX=$(( tx_rate / 1024 ))KB/s" "${MODULE}"
                fi
            done < <(tail -n +2 "${iface_file}")
        fi
    fi

    # Save current counters
    {
        echo "${timestamp}"
        for iface in "${!rx_bytes[@]}"; do
            echo "${iface}|${rx_bytes[${iface}]}|${tx_bytes[${iface}]}"
        done
    } > "${iface_file}"
}

# ============================================================
# DNS QUERY MONITORING (requires tcpdump or systemd-resolved)
# ============================================================
check_dns_anomalies() {
    log_debug "Checking DNS configuration" "${MODULE}"

    # Check for DNS over suspicious resolvers
    local resolvers
    resolvers=$(grep "^nameserver" /etc/resolv.conf 2>/dev/null | awk '{print $2}')

    local suspicious_dns=()
    for resolver in ${resolvers}; do
        # Flag if not using well-known public DNS or private IPs
        if ! is_private_ip "${resolver}" && \
           [[ "${resolver}" != "8.8.8.8" ]] && \
           [[ "${resolver}" != "8.8.4.4" ]] && \
           [[ "${resolver}" != "1.1.1.1" ]] && \
           [[ "${resolver}" != "1.0.0.1" ]] && \
           [[ "${resolver}" != "9.9.9.9" ]] && \
           [[ "${resolver}" != "208.67.222.222" ]]; then
            suspicious_dns+=("${resolver}")
        fi
    done

    if [[ ${#suspicious_dns[@]} -gt 0 ]]; then
        db_insert_event "NETWORK" "SUSPICIOUS_DNS" 2 \
            "Servidores DNS incomuns configurados" \
            "DNS: ${suspicious_dns[*]}" "" "" 10
        log_warning "Unusual DNS servers: ${suspicious_dns[*]}" "${MODULE}"
    fi
}

# ============================================================
# ARP SPOOFING DETECTION
# ============================================================
check_arp_spoofing() {
    log_debug "Checking for ARP spoofing" "${MODULE}"

    local arp_file="${LSM_DATA_DIR}/arp_snapshot.txt"
    local current_arp
    current_arp=$(arp -n 2>/dev/null | grep -v "^Address\|^$" | awk '{print $1":"$3}' | sort || true)

    if [[ -f "${arp_file}" ]]; then
        local prev_arp
        prev_arp=$(cat "${arp_file}")

        # Check for MAC changes (possible ARP spoofing)
        while read -r entry; do
            [[ -z "${entry}" ]] && continue
            local ip mac
            ip=$(echo "${entry}" | cut -d: -f1)
            mac=$(echo "${entry}" | cut -d: -f2-)

            local prev_entry
            prev_entry=$(echo "${prev_arp}" | grep "^${ip}:" || true)

            if [[ -n "${prev_entry}" ]]; then
                local prev_mac
                prev_mac=$(echo "${prev_entry}" | cut -d: -f2-)
                if [[ "${mac}" != "${prev_mac}" ]] && [[ "${mac}" != "<incomplete>" ]]; then
                    db_insert_event "NETWORK" "ARP_SPOOF" 4 \
                        "Possível ARP Spoofing: ${ip}" \
                        "MAC anterior: ${prev_mac}\nMAC atual: ${mac}" \
                        "${ip}" "" 30

                    send_telegram "CRITICAL" "Possível ARP Spoofing" \
"⛔ Mudança de MAC detectada!
🌍 IP: \`${ip}\`
🔧 MAC anterior: ${prev_mac}
🔧 MAC atual: ${mac}
📌 Possível ataque man-in-the-middle!"

                    log_critical "ARP spoofing detected: ${ip} changed MAC ${prev_mac} -> ${mac}" "${MODULE}"
                fi
            fi
        done < <(echo "${current_arp}")
    fi

    echo "${current_arp}" > "${arp_file}"
}

# ============================================================
# MAIN
# ============================================================
main() {
    lsm_init

    case "${1:-check}" in
        check)
            check_port_scan
            check_suspicious_connections
            check_listening_services
            check_bandwidth
            ;;
        full)
            check_port_scan
            check_suspicious_connections
            check_listening_services
            check_bandwidth
            check_dns_anomalies
            check_arp_spoofing
            ;;
        scan)
            check_port_scan
            ;;
        connections)
            check_suspicious_connections
            ;;
        bandwidth)
            check_bandwidth
            ;;
        dns)
            check_dns_anomalies
            ;;
        arp)
            check_arp_spoofing
            ;;
        status)
            echo "Network Status:"
            echo "  Listening ports: $(ss -tlnp 2>/dev/null | grep -c LISTEN)"
            echo "  Active connections: $(ss -tn 2>/dev/null | grep -c ESTAB)"
            echo "  Interfaces:"
            ip addr show 2>/dev/null | grep "inet " | awk '{print "    "$2}'
            ;;
        *)
            echo "Usage: ${0} {check|full|scan|connections|bandwidth|dns|arp|status}"
            exit 1
            ;;
    esac
}

main "${@}"
