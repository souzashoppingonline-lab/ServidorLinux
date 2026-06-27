#!/bin/bash
# Linux Security Monitor - Update Script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

MODULE="UPDATE"
LSM_INSTALL_DIR="/opt/linux-security-monitor"
UPDATE_REPO="${UPDATE_REPO:-https://github.com/souzashoppingonline-lab/ServidorLinux}"
UPDATE_BRANCH="${UPDATE_BRANCH:-main}"

check_for_updates() {
    log_info "Checking for updates..." "${MODULE}"

    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf ${tmp_dir}" EXIT

    # Get latest version from repo
    if ! git clone --depth 1 --branch "${UPDATE_BRANCH}" "${UPDATE_REPO}" "${tmp_dir}" 2>/dev/null; then
        log_error "Failed to reach update repository" "${MODULE}"
        return 1
    fi

    local remote_version
    remote_version=$(grep 'LSM_VERSION=' "${tmp_dir}/scripts/lib.sh" 2>/dev/null | \
                     grep -oP '"[^"]*"' | tr -d '"' | head -1)

    echo "Current version: ${LSM_VERSION}"
    echo "Available version: ${remote_version:-unknown}"

    if [[ "${remote_version}" != "${LSM_VERSION}" ]]; then
        echo "Update available!"
        return 0
    else
        echo "Already up to date"
        return 1
    fi
}

perform_update() {
    log_info "Performing update..." "${MODULE}"
    [[ $EUID -ne 0 ]] && { echo "Must run as root"; exit 1; }

    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf ${tmp_dir}" EXIT

    echo "Downloading latest version..."
    git clone --depth 1 --branch "${UPDATE_BRANCH}" "${UPDATE_REPO}" "${tmp_dir}" 2>/dev/null

    # Backup current config
    local backup_dir="/var/lib/lsm/backups/$(date +%Y%m%d_%H%M%S)"
    mkdir -p "${backup_dir}"
    cp -r "${LSM_INSTALL_DIR}/config" "${backup_dir}/" 2>/dev/null || true
    echo "Config backed up to ${backup_dir}"

    # Stop services
    echo "Stopping services..."
    systemctl stop lsm-monitor lsm-scheduler lsm-web 2>/dev/null || true

    # Update scripts and web (preserve config)
    cp -r "${tmp_dir}/scripts/"* "${LSM_INSTALL_DIR}/scripts/"
    chmod +x "${LSM_INSTALL_DIR}/scripts/"*.sh
    cp -r "${tmp_dir}/web/"* "${LSM_INSTALL_DIR}/web/"

    # Update node dependencies
    cd "${LSM_INSTALL_DIR}/web" && npm update --production --silent 2>/dev/null

    # Restart services
    echo "Restarting services..."
    systemctl daemon-reload
    systemctl start lsm-monitor lsm-scheduler lsm-web 2>/dev/null || true

    log_info "Update completed" "${MODULE}"
    echo "Update complete! New version: $(grep 'LSM_VERSION=' "${LSM_INSTALL_DIR}/scripts/lib.sh" | grep -oP '"[^"]*"' | tr -d '"')"
}

case "${1:-check}" in
    check)  load_config; check_for_updates ;;
    update) load_config; perform_update ;;
    *)
        echo "Usage: ${0} {check|update}"
        exit 1
        ;;
esac
