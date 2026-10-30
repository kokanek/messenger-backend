#!/usr/bin/env bash
# Runs on the VM: bash messenger/infra/deploy.sh <image tag>
# Points .env at the given image tag, pulls the images and restarts whatever changed.
# Roll back by running it again with an older tag.
set -euo pipefail

tag="${1:?usage: deploy.sh <image tag>}"
cd "$(dirname "$0")/.."

if grep -q '^IMAGE_TAG=' .env; then
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${tag}/" .env
else
  echo "IMAGE_TAG=${tag}" >> .env
fi

docker compose pull --quiet
docker compose up -d --wait --remove-orphans
docker image prune -f
