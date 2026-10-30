#!/usr/bin/env bash
# Runs once on a fresh Debian VM, as the admin user: bash init-vm.sh <api domain>
# The admin user and its sudo come from the SSH key in the VM's metadata.
# Installs Docker Engine and Compose, lets admin use docker, adds swap on a machine with
# under 2 GB of memory, and writes ~/messenger/.env with fresh secrets.
# Safe to run again: an existing .env or swap file is left alone.
set -euo pipefail

domain="${1:?usage: init-vm.sh <api domain>}"

# Docker Engine and Compose from Docker's apt repository (docs.docker.com/engine/install/debian).
sudo apt-get update
sudo apt-get install -y ca-certificates curl openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Takes effect from the next login.
sudo usermod -aG docker "$USER"

# 2 GB of swap on a 1 GB machine such as an e2-micro (wiki.debian.org/Swap).
mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
if [ "$mem_kb" -lt 2000000 ] && [ ! -f /swapfile ]; then
  sudo dd if=/dev/zero of=/swapfile bs=1024 count=2097152
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
fi

# The production .env, with one random secret per line. Hex, not base64: the database
# passwords go into connection URLs, where / and + would break them.
mkdir -p ~/messenger
if [ ! -f ~/messenger/.env ]; then
  umask 077
  {
    cat <<EOF
COMPOSE_FILE=compose.yaml:compose.prod.yaml
NODE_ENV=production
LOG_LEVEL=info
API_DOMAIN=${domain}
ALLOWED_ORIGINS=http://localhost:5173
IMAGE_PREFIX=ghcr.io/kokanek/messenger
IMAGE_TAG=set-by-deploy
ADMIN_USERNAME=admin
EOF
    for v in JWT_SECRET INTERNAL_TOKEN ADMIN_PASSWORD POSTGRES_PASSWORD AUTH_DB_PASSWORD \
             MESSAGE_DB_PASSWORD MONGO_ROOT_PASSWORD CONVERSATION_DB_PASSWORD; do
      echo "$v=$(openssl rand -hex 32)"
    done
  } > ~/messenger/.env
fi

echo "Done. $(docker --version)"
echo "The admin password: grep ADMIN_PASSWORD ~/messenger/.env"
