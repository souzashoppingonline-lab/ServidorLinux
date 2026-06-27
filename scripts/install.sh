#!/bin/bash
# Linux Security Monitor - Installation Script
# Usage: curl -sSL <url>/install.sh | sudo bash
# Or: sudo bash install.sh

set -e

LSM_VERSION="1.0.0"
LSM_INSTALL_DIR="/opt/linux-security-monitor"
LSM_USER="lsm"
LSM_GROUP="lsm"
LSM_LOG_DIR="/var/log/lsm"
LSM_DATA_DIR="/var/lib/lsm"
LSM_RUN_DIR="/var/run/lsm"
LSM_REPO_URL="https://github.com/souzashoppingonline-lab/ServidorLinux"

# Colors
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

log_info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*"; }
log_step()    { echo -e "\n${CYAN}[STEP]${NC}  $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $*"; }

# ============================================================
# PREFLIGHT CHECKS
# ============================================================
check_root() {
    [[ $EUID -ne 0 ]] && { log_error "Must run as root (sudo bash install.sh)"; exit 1; }
}

check_os() {
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        case "${ID}" in
            ubuntu|debian|raspbian) ;;
            *) log_warn "Unsupported OS: ${PRETTY_NAME}. Continuing anyway..." ;;
        esac
    fi
    log_success "OS: $(grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' || uname -s)"
}

# ============================================================
# BANNER
# ============================================================
print_banner() {
    echo ""
    echo -e "${BLUE}"
    cat << 'BANNER'
 ___  ___ __  __
| |  / __|  \/  |
| |  \__ \ |\/| |
|___|___/_|  |_|

Linux Security Monitor v1.0.0
Professional Server Security for Ubuntu/Debian
BANNER
    echo -e "${NC}"
}

# ============================================================
# SYSTEM DEPENDENCIES
# ============================================================
install_dependencies() {
    log_step "Installing system dependencies..."

    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq

    local packages=(
        curl wget git sqlite3
        bc net-tools iproute2
        lsof procps psmisc
        openssl ca-certificates
        fail2ban
        logrotate
        jq
        python3
        cron
    )

    local to_install=()
    for pkg in "${packages[@]}"; do
        dpkg -s "${pkg}" &>/dev/null || to_install+=("${pkg}")
    done

    if [[ ${#to_install[@]} -gt 0 ]]; then
        apt-get install -y -qq "${to_install[@]}"
        log_success "Installed: ${to_install[*]}"
    else
        log_success "All system dependencies already installed"
    fi
}

# ============================================================
# NODE.JS
# ============================================================
install_nodejs() {
    log_step "Checking Node.js..."

    if command -v node &>/dev/null; then
        local version
        version=$(node --version 2>/dev/null | grep -oP '\d+' | head -1)
        if [[ "${version}" -ge 18 ]]; then
            log_success "Node.js $(node --version) already installed"
            return 0
        fi
        log_warn "Node.js ${version} is too old (need >= 18), upgrading..."
    fi

    log_info "Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null 2>&1
    log_success "Node.js $(node --version) installed"
}

# ============================================================
# SYSTEM USER
# ============================================================
create_system_user() {
    log_step "Creating system user..."

    if ! id "${LSM_USER}" &>/dev/null; then
        useradd --system --no-create-home \
            --shell /bin/false \
            --comment "Linux Security Monitor" \
            "${LSM_USER}"
        log_success "User ${LSM_USER} created"
    else
        log_success "User ${LSM_USER} already exists"
    fi

    # Add to systemd-journal group for log access
    usermod -aG adm,systemd-journal "${LSM_USER}" 2>/dev/null || true
}

# ============================================================
# DIRECTORY STRUCTURE
# ============================================================
create_directories() {
    log_step "Creating directory structure..."

    local dirs=(
        "${LSM_INSTALL_DIR}"
        "${LSM_INSTALL_DIR}/scripts"
        "${LSM_INSTALL_DIR}/web"
        "${LSM_INSTALL_DIR}/web/src"
        "${LSM_INSTALL_DIR}/web/public"
        "${LSM_INSTALL_DIR}/web/public/css"
        "${LSM_INSTALL_DIR}/web/public/js"
        "${LSM_INSTALL_DIR}/config"
        "${LSM_LOG_DIR}"
        "${LSM_DATA_DIR}"
        "${LSM_DATA_DIR}/reports"
        "${LSM_RUN_DIR}"
    )

    for dir in "${dirs[@]}"; do
        mkdir -p "${dir}"
    done

    chown -R "${LSM_USER}:${LSM_GROUP}" "${LSM_LOG_DIR}" "${LSM_DATA_DIR}" "${LSM_RUN_DIR}"
    chmod 750 "${LSM_LOG_DIR}" "${LSM_DATA_DIR}"
    chmod 755 "${LSM_RUN_DIR}"

    log_success "Directory structure created"
}

# ============================================================
# INSTALL FILES
# ============================================================
install_files() {
    log_step "Installing LSM files..."

    local src_dir
    src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

    # Copy scripts
    cp -r "${src_dir}/scripts/"* "${LSM_INSTALL_DIR}/scripts/"
    chmod +x "${LSM_INSTALL_DIR}/scripts/"*.sh

    # Copy web files
    cp -r "${src_dir}/web/"* "${LSM_INSTALL_DIR}/web/"

    # Copy config (only if not exists)
    if [[ ! -f "${LSM_INSTALL_DIR}/config/monitor.conf" ]]; then
        cp "${src_dir}/config/monitor.conf" "${LSM_INSTALL_DIR}/config/"
        log_info "Default config installed"
    else
        log_info "Existing config preserved"
    fi

    # Set permissions
    chmod 640 "${LSM_INSTALL_DIR}/config/monitor.conf"
    chown root:${LSM_GROUP} "${LSM_INSTALL_DIR}/config/monitor.conf"

    log_success "LSM files installed"
}

# ============================================================
# NODE.JS DEPENDENCIES
# ============================================================
install_node_deps() {
    log_step "Installing Node.js dependencies..."

    cat > "${LSM_INSTALL_DIR}/web/package.json" << 'EOF'
{
    "name": "linux-security-monitor-web",
    "version": "1.0.0",
    "description": "Linux Security Monitor Web Dashboard",
    "main": "src/server.js",
    "dependencies": {
        "ws": "^8.16.0",
        "better-sqlite3": "^9.4.3"
    },
    "engines": { "node": ">=18.0.0" }
}
EOF

    cd "${LSM_INSTALL_DIR}/web" && npm install --production --silent 2>/dev/null
    log_success "Node.js dependencies installed"
}

# ============================================================
# SYSTEMD SERVICES
# ============================================================
install_systemd() {
    log_step "Installing systemd services..."

    # Main monitor service
    cat > /etc/systemd/system/lsm-monitor.service << EOF
[Unit]
Description=Linux Security Monitor
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${LSM_INSTALL_DIR}
ExecStart=/bin/bash ${LSM_INSTALL_DIR}/scripts/monitor.sh loop
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=10
StandardOutput=append:${LSM_LOG_DIR}/monitor.log
StandardError=append:${LSM_LOG_DIR}/monitor.log
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

    # Scheduler service
    cat > /etc/systemd/system/lsm-scheduler.service << EOF
[Unit]
Description=Linux Security Monitor Scheduler
After=lsm-monitor.service

[Service]
Type=simple
User=root
WorkingDirectory=${LSM_INSTALL_DIR}
ExecStart=/bin/bash ${LSM_INSTALL_DIR}/scripts/daemon.sh scheduler
Restart=always
RestartSec=30
StandardOutput=append:${LSM_LOG_DIR}/scheduler.log
StandardError=append:${LSM_LOG_DIR}/scheduler.log

[Install]
WantedBy=multi-user.target
EOF

    # Web dashboard service
    cat > /etc/systemd/system/lsm-web.service << EOF
[Unit]
Description=Linux Security Monitor Web Dashboard
After=lsm-monitor.service
Requires=lsm-monitor.service

[Service]
Type=simple
User=${LSM_USER}
Group=${LSM_GROUP}
WorkingDirectory=${LSM_INSTALL_DIR}/web
EnvironmentFile=${LSM_INSTALL_DIR}/config/monitor.conf
ExecStart=/usr/bin/node ${LSM_INSTALL_DIR}/web/src/server.js
Restart=always
RestartSec=10
StandardOutput=append:${LSM_LOG_DIR}/web.log
StandardError=append:${LSM_LOG_DIR}/web.log
ReadOnlyPaths=${LSM_INSTALL_DIR}
ReadWritePaths=${LSM_LOG_DIR}

[Install]
WantedBy=multi-user.target
EOF

    # Target to start all
    cat > /etc/systemd/system/lsm.target << EOF
[Unit]
Description=Linux Security Monitor (all services)
Requires=lsm-monitor.service lsm-scheduler.service lsm-web.service
After=lsm-monitor.service lsm-scheduler.service lsm-web.service

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    log_success "Systemd services installed"
}

# ============================================================
# CLI TOOL
# ============================================================
install_cli() {
    log_step "Installing CLI tool..."

    cat > /usr/local/bin/lsm << CLISCRIPT
#!/bin/bash
# LSM CLI wrapper
export LSM_INSTALL_DIR="${LSM_INSTALL_DIR}"

case "\${1:-}" in
    start)
        systemctl start lsm-monitor lsm-scheduler lsm-web
        echo "LSM started"
        ;;
    stop)
        systemctl stop lsm-monitor lsm-scheduler lsm-web
        echo "LSM stopped"
        ;;
    restart)
        systemctl restart lsm-monitor lsm-scheduler lsm-web
        echo "LSM restarted"
        ;;
    status)
        bash "${LSM_INSTALL_DIR}/scripts/daemon.sh" status
        ;;
    logs)
        journalctl -u lsm-monitor -f --no-pager
        ;;
    audit)
        bash "${LSM_INSTALL_DIR}/scripts/audit.sh" "\${2:-quick}"
        ;;
    integrity)
        bash "${LSM_INSTALL_DIR}/scripts/integrity.sh" "\${2:-check}"
        ;;
    users)
        bash "${LSM_INSTALL_DIR}/scripts/users.sh" "\${2:-status}"
        ;;
    risk)
        bash "${LSM_INSTALL_DIR}/scripts/daemon.sh" status | grep "Risk"
        ;;
    update)
        bash "${LSM_INSTALL_DIR}/scripts/update.sh"
        ;;
    telegram)
        bash "${LSM_INSTALL_DIR}/scripts/telegram.sh" "\${2:-test}"
        ;;
    events)
        sqlite3 "${LSM_DATA_DIR}/lsm.db" \
            "SELECT datetime(timestamp,'unixepoch','localtime'), module, severity, title FROM events ORDER BY timestamp DESC LIMIT \${2:-20};" 2>/dev/null
        ;;
    version)
        echo "Linux Security Monitor v${LSM_VERSION}"
        ;;
    help|*)
        echo ""
        echo "Linux Security Monitor v${LSM_VERSION}"
        echo ""
        echo "Usage: lsm <command> [options]"
        echo ""
        echo "Commands:"
        echo "  start           Start all LSM services"
        echo "  stop            Stop all LSM services"
        echo "  restart         Restart all LSM services"
        echo "  status          Show system status and risk score"
        echo "  logs            Follow monitor logs"
        echo "  audit [type]    Run security audit (quick|full|users|ssh|ports)"
        echo "  integrity       Check file integrity"
        echo "  users           Show user security status"
        echo "  risk            Show current risk score"
        echo "  events [N]      Show last N events (default: 20)"
        echo "  telegram test   Test Telegram connection"
        echo "  update          Update LSM to latest version"
        echo "  version         Show version"
        echo ""
        ;;
esac
CLISCRIPT

    chmod +x /usr/local/bin/lsm
    log_success "CLI tool installed at /usr/local/bin/lsm"
}

# ============================================================
# LOG ROTATION
# ============================================================
setup_logrotate() {
    log_step "Configuring log rotation..."

    cat > /etc/logrotate.d/lsm << EOF
${LSM_LOG_DIR}/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        systemctl reload lsm-monitor 2>/dev/null || true
    endscript
}
EOF

    log_success "Log rotation configured"
}

# ============================================================
# FAIL2BAN INTEGRATION
# ============================================================
setup_fail2ban() {
    log_step "Configuring Fail2ban..."

    if ! command -v fail2ban-client &>/dev/null; then
        log_warn "Fail2ban not available, skipping"
        return 0
    fi

    cat > /etc/fail2ban/jail.d/lsm.conf << 'EOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = %(sshd_log)s
maxretry = 3
bantime = 7200

[sshd-ddos]
enabled = true
port = ssh
filter = sshd-ddos
logpath = %(sshd_log)s
maxretry = 6
EOF

    systemctl enable fail2ban 2>/dev/null || true
    systemctl restart fail2ban 2>/dev/null || true
    log_success "Fail2ban configured"
}

# ============================================================
# INITIAL CONFIGURATION
# ============================================================
configure_web_password() {
    log_step "Configuring web dashboard..."

    local password
    echo ""
    echo "Set web dashboard password (default: admin):"
    read -rsp "Password [admin]: " password
    echo ""
    password="${password:-admin}"

    local hash
    hash=$(echo -n "${password}" | sha256sum | awk '{print $1}')

    sed -i "s|WEB_PASSWORD_HASH=.*|WEB_PASSWORD_HASH=\"${hash}\"|" \
        "${LSM_INSTALL_DIR}/config/monitor.conf"

    local secret
    secret=$(openssl rand -hex 32)
    sed -i "s|WEB_SESSION_SECRET=.*|WEB_SESSION_SECRET=\"${secret}\"|" \
        "${LSM_INSTALL_DIR}/config/monitor.conf"

    log_success "Web dashboard configured (port: 8443)"
}

# ============================================================
# INITIALIZE DATABASE & BASELINE
# ============================================================
initialize_system() {
    log_step "Initializing database and baseline..."

    bash "${LSM_INSTALL_DIR}/scripts/lib.sh" 2>/dev/null || true

    # Init db directly
    sqlite3 "${LSM_DATA_DIR}/lsm.db" "SELECT 1;" 2>/dev/null || true
    source "${LSM_INSTALL_DIR}/scripts/lib.sh" 2>/dev/null && lsm_init 2>/dev/null || true

    # Create integrity baseline
    log_info "Creating file integrity baseline..."
    bash "${LSM_INSTALL_DIR}/scripts/integrity.sh" baseline 2>/dev/null || true

    # Initial user snapshot
    bash "${LSM_INSTALL_DIR}/scripts/users.sh" check 2>/dev/null || true

    log_success "System initialized"
}

# ============================================================
# START SERVICES
# ============================================================
start_services() {
    log_step "Starting LSM services..."

    systemctl enable lsm-monitor lsm-scheduler lsm-web 2>/dev/null || true
    systemctl start lsm-monitor lsm-scheduler 2>/dev/null || {
        log_warn "Could not start systemd services (maybe no systemd available)"
    }

    # Try web separately
    systemctl start lsm-web 2>/dev/null || log_warn "Web service start failed"

    sleep 3
    log_success "LSM services started"
}

# ============================================================
# PRINT SUCCESS
# ============================================================
print_success() {
    local private_ip
    private_ip=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "localhost")

    echo ""
    echo -e "${GREEN}================================================${NC}"
    echo -e "${GREEN}  Linux Security Monitor v${LSM_VERSION} Installed!${NC}"
    echo -e "${GREEN}================================================${NC}"
    echo ""
    echo -e "  ${CYAN}Web Dashboard:${NC} http://${private_ip}:8443"
    echo -e "  ${CYAN}Username:${NC}      admin"
    echo ""
    echo -e "  ${CYAN}CLI Commands:${NC}"
    echo -e "    lsm status        - Show system status"
    echo -e "    lsm logs          - Follow logs"
    echo -e "    lsm audit         - Run security audit"
    echo -e "    lsm events        - Show recent events"
    echo -e "    lsm telegram test - Test Telegram alerts"
    echo ""
    echo -e "  ${CYAN}Services:${NC}"
    echo -e "    systemctl status lsm-monitor"
    echo -e "    systemctl status lsm-web"
    echo ""
    echo -e "  ${YELLOW}Configure Telegram:${NC}"
    echo -e "    lsm telegram configure"
    echo ""
}

# ============================================================
# MAIN
# ============================================================
main() {
    print_banner
    check_root
    check_os
    install_dependencies
    install_nodejs
    create_system_user
    create_directories
    install_files
    install_node_deps
    install_systemd
    install_cli
    setup_logrotate
    setup_fail2ban
    configure_web_password
    initialize_system
    start_services
    print_success
}

main "${@}"
