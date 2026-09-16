#!/usr/bin/env bash
# Explicit environment; validate the complete shared nginx configuration every time.
set -Eeuo pipefail
case "${DEPLOY_ENV:-}" in gcp|ru) ;; *) echo 'DEPLOY_ENV must be gcp or ru' >&2; exit 1;; esac
REPO_DIR=${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
NGINX_ROOT=${NGINX_ROOT:-/etc/nginx}
backup=''
changed=0
restore() {
  if (( changed )); then
    sudo rm -f "$NGINX_ROOT/sites-enabled/relay"
    if [[ -e "$backup/relay" || -L "$backup/relay" ]]; then
      sudo cp -a "$backup/relay" "$NGINX_ROOT/sites-enabled/relay"
    fi
    echo "Restored previous relay; backup: $backup" >&2
    sudo nginx -t || true
  fi
}
trap 'restore; exit 1' ERR
sudo nginx -t
if [[ "$DEPLOY_ENV" == gcp ]]; then
  src="$REPO_DIR/infra/nginx/relay.conf"
  dst="$NGINX_ROOT/sites-enabled/relay"
  if ! sudo cmp -s "$src" "$dst"; then
    backup=$(sudo mktemp -d "$NGINX_ROOT/relay-backup.XXXXXX")
    if [[ -e "$dst" || -L "$dst" ]]; then sudo cp -a "$dst" "$backup/relay"; fi
    changed=1
    sudo install -m 644 "$src" "$backup/candidate"
    sudo mv -T "$backup/candidate" "$dst"
    sudo nginx -t
  fi
fi
# RU never installs relay. A broken pre-existing config fails loudly.
if sudo systemctl is-active --quiet nginx; then
  sudo systemctl reload nginx
else
  sudo systemctl start nginx
fi
trap - ERR
