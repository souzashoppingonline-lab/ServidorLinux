#!/bin/bash
# Linux Security Monitor - Telegram Alert Module

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

MODULE="TELEGRAM"

# ============================================================
# CORE SEND FUNCTION
# ============================================================
telegram_send_message() {
    local chat_id="${1}"
    local text="${2}"
    local parse_mode="${3:-Markdown}"
    local disable_preview="${4:-true}"

    [[ -z "${TELEGRAM_BOT_TOKEN}" ]] && { log_error "TELEGRAM_BOT_TOKEN not set" "${MODULE}"; return 1; }
    [[ -z "${chat_id}" ]] && { log_error "Chat ID required" "${MODULE}"; return 1; }

    local response
    response=$(curl -s -X POST \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        --max-time 15 \
        --retry 3 \
        --retry-delay 2 \
        -H "Content-Type: application/json" \
        -d "{
            \"chat_id\": \"${chat_id}\",
            \"text\": $(echo "${text}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
            \"parse_mode\": \"${parse_mode}\",
            \"disable_web_page_preview\": ${disable_preview}
        }" 2>/dev/null)

    local ok
    ok=$(echo "${response}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ok','false'))" 2>/dev/null)

    if [[ "${ok}" == "True" ]]; then
        log_debug "Telegram message sent to ${chat_id}" "${MODULE}"
        return 0
    else
        local err
        err=$(echo "${response}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('description','unknown error'))" 2>/dev/null)
        log_error "Telegram send failed: ${err}" "${MODULE}"
        return 1
    fi
}

# ============================================================
# ALERT FORMATTERS
# ============================================================
alert_critical() {
    local title="${1}"
    local body="${2}"
    local hostname
    hostname=$(get_hostname)
    local risk_score
    risk_score=$(db_exec "SELECT COALESCE(score,0) FROM risk_scores ORDER BY timestamp DESC LIMIT 1;" 2>/dev/null || echo "0")

    local text
    text="🔴 *ALERTA CRÍTICO*
━━━━━━━━━━━━━━━━━━━━
*${title}*

🖥️ Servidor: \`${hostname}\`
🕐 Hora: $(date '+%d/%m/%Y %H:%M:%S')
⚠️ Risk Score: ${risk_score}/100

${body}

━━━━━━━━━━━━━━━━━━━━
_Linux Security Monitor v${LSM_VERSION}_"

    telegram_send_message "${TELEGRAM_CHAT_ID}" "${text}"
    log_critical "Telegram CRITICAL alert sent: ${title}" "${MODULE}"
}

alert_warning() {
    local title="${1}"
    local body="${2}"
    local hostname
    hostname=$(get_hostname)

    local text
    text="🟡 *AVISO*
━━━━━━━━━━━━━━━━━━━━
*${title}*

🖥️ Servidor: \`${hostname}\`
🕐 Hora: $(date '+%d/%m/%Y %H:%M:%S')

${body}

━━━━━━━━━━━━━━━━━━━━
_Linux Security Monitor v${LSM_VERSION}_"

    telegram_send_message "${TELEGRAM_CHAT_ID}" "${text}"
    log_warning "Telegram WARNING alert sent: ${title}" "${MODULE}"
}

alert_info() {
    local title="${1}"
    local body="${2}"
    local hostname
    hostname=$(get_hostname)

    local text
    text="🔵 *INFO*
━━━━━━━━━━━━━━━━━━━━
*${title}*

🖥️ Servidor: \`${hostname}\`
🕐 Hora: $(date '+%d/%m/%Y %H:%M:%S')

${body}

━━━━━━━━━━━━━━━━━━━━
_Linux Security Monitor v${LSM_VERSION}_"

    telegram_send_message "${TELEGRAM_CHAT_ID}" "${text}"
}

# ============================================================
# SPECIFIC ALERT TEMPLATES
# ============================================================
alert_ssh_failed() {
    local ip="${1}"
    local user="${2}"
    local count="${3}"

    alert_critical "Tentativas de Login SSH" \
"👤 Usuário: \`${user}\`
🌍 IP: \`${ip}\`
🔢 Tentativas: ${count}
📌 Status: Possível ataque de força bruta"
}

alert_ssh_root_login() {
    local ip="${1}"

    alert_critical "Login Root via SSH Detectado" \
"🌍 IP de origem: \`${ip}\`
⛔ Login root é uma prática insegura
📌 Recomendação: Desabilite login root no SSH"
}

alert_new_user() {
    local username="${1}"
    local created_by="${2}"

    alert_warning "Novo Usuário Criado" \
"👤 Usuário: \`${username}\`
👮 Criado por: \`${created_by}\`
📌 Verifique se a criação foi autorizada"
}

alert_sudo_command() {
    local username="${1}"
    local command="${2}"

    alert_info "Comando sudo Executado" \
"👤 Usuário: \`${username}\`
💻 Comando: \`${command}\`"
}

alert_integrity_change() {
    local filepath="${1}"
    local change_type="${2}"

    alert_critical "Alteração de Arquivo Crítico" \
"📄 Arquivo: \`${filepath}\`
🔄 Tipo: ${change_type}
📌 Possível comprometimento do sistema"
}

alert_high_cpu() {
    local usage="${1}"
    local process="${2}"

    alert_warning "Alto Uso de CPU" \
"📊 Uso: ${usage}%
🔧 Processo principal: \`${process}\`
📌 Verifique processos suspeitos"
}

alert_high_disk() {
    local path="${1}"
    local usage="${2}"

    alert_warning "Disco Quase Cheio" \
"💾 Partição: \`${path}\`
📊 Uso: ${usage}%
📌 Libere espaço para evitar problemas"
}

alert_port_scan() {
    local ip="${1}"
    local connections="${2}"

    alert_critical "Possível Port Scan Detectado" \
"🌍 IP: \`${ip}\`
🔢 Conexões: ${connections}
📌 Verificar regras de firewall"
}

alert_suspicious_process() {
    local process="${1}"
    local pid="${2}"
    local user="${3}"

    alert_critical "Processo Suspeito Detectado" \
"🔧 Processo: \`${process}\`
🔢 PID: ${pid}
👤 Usuário: \`${user}\`
📌 Investigue imediatamente"
}

alert_ssl_expiring() {
    local domain="${1}"
    local days="${2}"

    alert_warning "Certificado SSL Expirando" \
"🌐 Domínio: \`${domain}\`
📅 Expira em: ${days} dias
📌 Renove o certificado SSL"
}

# ============================================================
# BOT MANAGEMENT
# ============================================================
test_telegram_connection() {
    load_config

    [[ -z "${TELEGRAM_BOT_TOKEN}" ]] && { echo "ERROR: TELEGRAM_BOT_TOKEN not configured"; return 1; }
    [[ -z "${TELEGRAM_CHAT_ID}" ]] && { echo "ERROR: TELEGRAM_CHAT_ID not configured"; return 1; }

    echo "Testing Telegram connection..."

    local response
    response=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" --max-time 10 2>/dev/null)
    local ok
    ok=$(echo "${response}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ok','false'))" 2>/dev/null)

    if [[ "${ok}" != "True" ]]; then
        echo "ERROR: Invalid bot token or network error"
        return 1
    fi

    local bot_name
    bot_name=$(echo "${response}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result']['username'])" 2>/dev/null)
    echo "Bot found: @${bot_name}"

    alert_info "Linux Security Monitor Configurado" \
"✅ Conexão estabelecida com sucesso!
🖥️ Servidor: \`$(get_hostname)\`
🐧 Sistema: $(get_os_info)
🔢 Versão LSM: ${LSM_VERSION}

O monitoramento está ativo."

    echo "SUCCESS: Test message sent to chat ${TELEGRAM_CHAT_ID}"
}

configure_telegram() {
    load_config

    echo ""
    echo "=== Configuração do Telegram ==="
    echo ""
    echo "1. Crie um bot em @BotFather no Telegram"
    echo "2. Copie o token gerado"
    echo ""
    read -rp "Token do Bot: " bot_token
    read -rp "Chat ID (seu ID ou grupo): " chat_id

    if [[ -z "${bot_token}" || -z "${chat_id}" ]]; then
        echo "ERROR: Token e Chat ID são obrigatórios"
        return 1
    fi

    # Update config
    local config_file="${LSM_CONFIG_FILE}"
    sed -i "s|TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=\"${bot_token}\"|" "${config_file}"
    sed -i "s|TELEGRAM_CHAT_ID=.*|TELEGRAM_CHAT_ID=\"${chat_id}\"|" "${config_file}"
    sed -i "s|TELEGRAM_ENABLED=.*|TELEGRAM_ENABLED=true|" "${config_file}"

    echo "Configuration saved. Testing connection..."
    TELEGRAM_BOT_TOKEN="${bot_token}" TELEGRAM_CHAT_ID="${chat_id}" TELEGRAM_ENABLED="true" \
        test_telegram_connection
}

send_daily_report() {
    load_config
    [[ "${TELEGRAM_ENABLED}" != "true" ]] && return 0

    local hostname
    hostname=$(get_hostname)
    local now
    now=$(date '+%d/%m/%Y')
    local risk_score
    risk_score=$(calculate_risk_score 2>/dev/null || echo "0")
    local risk_level
    risk_level=$(get_risk_level "${risk_score}")

    local events_24h
    events_24h=$(db_exec "SELECT COUNT(*) FROM events WHERE timestamp > strftime('%s','now','-24 hours');" 2>/dev/null || echo "0")
    local critical_events
    critical_events=$(db_exec "SELECT COUNT(*) FROM events WHERE severity=4 AND timestamp > strftime('%s','now','-24 hours');" 2>/dev/null || echo "0")
    local failed_logins
    failed_logins=$(db_exec "SELECT COUNT(*) FROM events WHERE module='SSH' AND event_type='FAILED_LOGIN' AND timestamp > strftime('%s','now','-24 hours');" 2>/dev/null || echo "0")

    local cpu_avg
    cpu_avg=$(db_exec "SELECT ROUND(AVG(metric_value),1) FROM metrics WHERE metric_name='cpu_usage' AND timestamp > strftime('%s','now','-24 hours');" 2>/dev/null || echo "0")
    local mem_avg
    mem_avg=$(db_exec "SELECT ROUND(AVG(metric_value),1) FROM metrics WHERE metric_name='memory_usage' AND timestamp > strftime('%s','now','-24 hours');" 2>/dev/null || echo "0")

    local risk_emoji
    case "${risk_level}" in
        CRITICAL) risk_emoji="🔴" ;;
        HIGH)     risk_emoji="🟠" ;;
        MEDIUM)   risk_emoji="🟡" ;;
        *)        risk_emoji="🟢" ;;
    esac

    local text
    text="📊 *RELATÓRIO DIÁRIO - ${now}*
━━━━━━━━━━━━━━━━━━━━
🖥️ Servidor: \`${hostname}\`

${risk_emoji} *Risk Score: ${risk_score}/100 (${risk_level})*

📈 *Eventos (últimas 24h)*
• Total: ${events_24h}
• Críticos: ${critical_events}
• Tentativas de login: ${failed_logins}

💻 *Recursos*
• CPU médio: ${cpu_avg}%
• Memória média: ${mem_avg}%

━━━━━━━━━━━━━━━━━━━━
_Linux Security Monitor v${LSM_VERSION}_"

    telegram_send_message "${TELEGRAM_CHAT_ID}" "${text}"
    log_info "Daily report sent via Telegram" "${MODULE}"
}

# Main entrypoint for CLI usage
case "${1:-}" in
    test)        load_config; test_telegram_connection ;;
    configure)   configure_telegram ;;
    report)      load_config; lsm_init; send_daily_report ;;
    critical)    load_config; lsm_init; alert_critical "${2:-Test}" "${3:-Test message}" ;;
    warning)     load_config; lsm_init; alert_warning "${2:-Test}" "${3:-Test message}" ;;
    info)        load_config; lsm_init; alert_info "${2:-Test}" "${3:-Test message}" ;;
    *)
        echo "Usage: ${0} {test|configure|report|critical|warning|info}"
        exit 1
        ;;
esac
