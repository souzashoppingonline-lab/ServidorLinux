#!/bin/bash
# ML Dashboard — Installation Script
# Run as root: bash install.sh

set -e

APP_DIR="/opt/ml-dashboard"
DATA_DIR="/var/lib/ml-dashboard"
SERVICE="ml-dashboard"

echo "============================================"
echo "  ML Dashboard — CFO Mercado Livre"
echo "  Instalação automática"
echo "============================================"

# Node.js 20+ required
if ! command -v node &> /dev/null; then
    echo "→ Instalando Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_VER" -lt 18 ]; then
    echo "ERRO: Node.js 18+ necessário (encontrado: $NODE_VER)"
    exit 1
fi

echo "→ Node.js $(node --version) ✓"

# Create app directory
echo "→ Criando diretórios..."
mkdir -p "$APP_DIR" "$DATA_DIR"
chown www-data:www-data "$DATA_DIR"

# Copy files
echo "→ Copiando arquivos..."
cp -r src package.json public "$APP_DIR/"

# Install dependencies
echo "→ Instalando dependências..."
cd "$APP_DIR"
npm install --production --silent

# Set permissions
chown -R www-data:www-data "$APP_DIR"
chmod 755 "$APP_DIR"

# Install systemd service
echo "→ Instalando serviço systemd..."
cp "$(dirname "$0")/systemd/${SERVICE}.service" "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable "${SERVICE}"
systemctl restart "${SERVICE}"

echo ""
echo "============================================"
echo "  ✅ Instalação concluída!"
echo ""
echo "  Status: systemctl status ${SERVICE}"
echo "  Logs:   journalctl -u ${SERVICE} -f"
echo "  URL:    http://localhost:3001"
echo ""
echo "  ⚙️  Configure o Nginx:"
echo "  cp nginx.conf /etc/nginx/sites-available/${SERVICE}"
echo "  ln -s /etc/nginx/sites-available/${SERVICE} /etc/nginx/sites-enabled/"
echo "  certbot --nginx -d multimixvendas.duckdns.org"
echo "  nginx -t && systemctl reload nginx"
echo "============================================"
