#!/bin/bash
set -e

# ============================================
# TonesinTime Cloud - Server Deployment Script
# Run this on a fresh Ubuntu 22.04+ VPS
# Usage: curl -sSL <your-url>/deploy.sh | bash
#   or:  bash deploy.sh
# ============================================

DOMAIN=""
EMAIL=""
STRIPE_KEY=""
STRIPE_WEBHOOK_SECRET=""
JWT_SECRET=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_step() { echo -e "\n${CYAN}[$1/$TOTAL_STEPS]${NC} $2"; }
print_ok() { echo -e "${GREEN}✓${NC} $1"; }
print_warn() { echo -e "${YELLOW}!${NC} $1"; }

TOTAL_STEPS=10

echo -e "${CYAN}"
echo "╔══════════════════════════════════════╗"
echo "║       TonesinTime Cloud Setup        ║"
echo "╚══════════════════════════════════════╝"
echo -e "${NC}"

# ---- Gather info ----
read -p "Enter your domain (e.g. tonesintime.io): " DOMAIN
read -p "Enter your email (for SSL certs): " EMAIL
read -p "Enter Stripe secret key (sk_...) or press Enter to skip: " STRIPE_KEY
read -p "Enter Stripe webhook secret (whsec_...) or press Enter to skip: " STRIPE_WEBHOOK_SECRET

# Generate secrets
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -base64 12)

# ---- Step 1: System updates ----
print_step 1 "Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get upgrade -y -qq
print_ok "System updated"

# ---- Step 2: Install Docker ----
print_step 2 "Installing Docker..."
if command -v docker &> /dev/null; then
    print_ok "Docker already installed"
else
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
    print_ok "Docker installed"
fi

# ---- Step 3: Install Docker Compose ----
print_step 3 "Installing Docker Compose..."
if command -v docker compose &> /dev/null; then
    print_ok "Docker Compose already installed"
else
    sudo apt-get install -y -qq docker-compose-plugin
    print_ok "Docker Compose installed"
fi

# ---- Step 4: Install Node.js ----
print_step 4 "Installing Node.js 20..."
if command -v node &> /dev/null; then
    print_ok "Node.js already installed ($(node -v))"
else
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
    print_ok "Node.js $(node -v) installed"
fi

# ---- Step 5: Install Nginx + Certbot ----
print_step 5 "Installing Nginx and Certbot..."
sudo apt-get install -y -qq nginx certbot python3-certbot-nginx
print_ok "Nginx and Certbot installed"

# ---- Step 6: Set up project directory ----
print_step 6 "Setting up TonesinTime Cloud..."
APP_DIR="/opt/tonesintime"
sudo mkdir -p $APP_DIR
sudo chown $USER:$USER $APP_DIR

# Copy cloud files (assumes this script is run from the repo)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp -r "$SCRIPT_DIR/server" "$APP_DIR/"
cp -r "$SCRIPT_DIR/docker" "$APP_DIR/"
cp -r "$SCRIPT_DIR/dashboard" "$APP_DIR/"

# Install server dependencies
cd "$APP_DIR/server"
npm install --production
print_ok "Project files deployed to $APP_DIR"

# ---- Step 7: Create .env ----
print_step 7 "Configuring environment..."
cat > "$APP_DIR/server/.env" << ENVEOF
PORT=3000
JWT_SECRET=$JWT_SECRET
STRIPE_SECRET_KEY=${STRIPE_KEY:-sk_test_placeholder}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET:-whsec_placeholder}
DOMAIN=$DOMAIN
DATABASE_PATH=$APP_DIR/server/tonesintime.db
DOCKER_SOCKET=/var/run/docker.sock
ICECAST_PORT_START=8001
ICECAST_PORT_END=9000
ENVEOF
print_ok "Environment configured"

# ---- Step 8: Build Icecast Docker image ----
print_step 8 "Building Icecast Docker image..."
cd "$APP_DIR/docker/icecast"
docker build -t tonesintime-icecast . 2>&1 | tail -1
docker network create tonesintime 2>/dev/null || true
print_ok "Icecast Docker image ready"

# ---- Step 9: Configure Nginx ----
print_step 9 "Configuring Nginx..."
sudo tee /etc/nginx/sites-available/tonesintime > /dev/null << NGINXEOF
# TonesinTime Cloud - Nginx Config

# API server
server {
    listen 80;
    server_name api.$DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

# Dashboard
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;

    root $APP_DIR/dashboard;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}

# Wildcard stream proxy - routes username.domain.com to correct Icecast port
server {
    listen 80;
    server_name ~^(?<subdomain>.+)\.$( echo "$DOMAIN" | sed 's/\./\\./g')$;

    location / {
        # Resolved dynamically by the API via upstream config
        # For now, streams are accessed directly via IP:port
        proxy_pass http://127.0.0.1:3000/api/proxy/\$subdomain\$request_uri;
        proxy_set_header Host \$host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}

# Direct port access for Icecast streams (8001-9000)
server {
    listen 80;
    server_name streams.$DOMAIN;

    location ~ ^/(\d+)(/.*)$ {
        proxy_pass http://127.0.0.1:\$1\$2;
        proxy_set_header Host \$host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
NGINXEOF

sudo ln -sf /etc/nginx/sites-available/tonesintime /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
print_ok "Nginx configured"

# ---- Step 10: Create systemd service ----
print_step 10 "Creating systemd service..."
sudo tee /etc/systemd/system/tonesintime.service > /dev/null << SVCEOF
[Unit]
Description=TonesinTime Cloud API
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR/server
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF

sudo systemctl daemon-reload
sudo systemctl enable tonesintime
sudo systemctl start tonesintime
print_ok "TonesinTime service started"

# ---- SSL (optional) ----
echo ""
read -p "Set up SSL with Let's Encrypt? (y/n): " SETUP_SSL
if [ "$SETUP_SSL" = "y" ]; then
    sudo certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" -d "api.$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive
    print_ok "SSL certificates installed"
fi

# ---- Done ----
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗"
echo "║     TonesinTime Cloud is running!        ║"
echo "╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Dashboard:  ${CYAN}http://$DOMAIN${NC}"
echo -e "  API:        ${CYAN}http://api.$DOMAIN${NC}"
echo -e "  Stream URL:  ${CYAN}http://$DOMAIN:PORT/stream${NC}"
echo ""
echo -e "  JWT Secret: ${YELLOW}$JWT_SECRET${NC}"
echo ""
echo -e "  Config:     ${CYAN}$APP_DIR/server/.env${NC}"
echo -e "  Logs:       ${CYAN}sudo journalctl -u tonesintime -f${NC}"
echo -e "  Restart:    ${CYAN}sudo systemctl restart tonesintime${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Point your DNS A record for $DOMAIN to this server's IP"
echo "  2. Point *.${DOMAIN} (wildcard) to this server's IP"
echo "  3. Update Stripe keys in $APP_DIR/server/.env"
echo "  4. Run SSL setup if you haven't: sudo certbot --nginx"
echo ""
