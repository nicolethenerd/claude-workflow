#!/usr/bin/env bash
# One-time setup script for a fresh Ubuntu EC2 instance.
# Run as: bash scripts/setup-ec2.sh
set -euo pipefail

REPO_URL="https://github.com/YOUR_ORG/claude-workflow.git"
APP_DIR="/home/ubuntu/claude-workflow"

echo "==> Installing Docker..."
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin

usermod -aG docker ubuntu
systemctl enable docker

echo "==> Cloning repo..."
git clone "$REPO_URL" "$APP_DIR"
chown -R ubuntu:ubuntu "$APP_DIR"

echo ""
echo "==> Done! Next steps:"
echo ""
echo "  1. Create your .env file:"
echo "       cp $APP_DIR/.env.example $APP_DIR/.env"
echo "       nano $APP_DIR/.env   # fill in all values"
echo ""
echo "  2. Add your projects.json:"
echo "       nano $APP_DIR/projects.json"
echo ""
echo "  3. Start the service:"
echo "       cd $APP_DIR && docker compose up -d --build"
echo ""
echo "  4. Check logs:"
echo "       docker compose logs -f"
