#!/bin/bash
# setup-publish-domains.sh — configure nginx virtual hosts for instant-publish custom domains
#
# Usage:
#   ./setup-publish-domains.sh                          # installs all domains listed below
#   ./setup-publish-domains.sh report.recruiter-assistant.ru   # one domain only
#
# Prerequisites:
#   1. DNS A record for the domain pointing to this VM's IP (136.65.7.197)
#   2. Run as root or with sudo
#   3. nginx + certbot installed (both are on the GCP VM already)
#
# What it does:
#   1. Writes nginx server block for the domain
#   2. Reloads nginx
#   3. Gets SSL cert via certbot
#   4. nginx auto-reloads to activate HTTPS

set -e

AGENT_PORT=8080
DOMAINS=("report.recruiter-assistant.ru" "flexi-consult.manager-assistant.ru")

# If a specific domain was passed, use only that
if [ -n "$1" ]; then
  DOMAINS=("$1")
fi

write_nginx_config() {
  local domain="$1"
  local conf="/etc/nginx/sites-available/${domain}.conf"

  cat > "$conf" <<NGINX
server {
    listen 80;
    server_name ${domain};

    # For certbot HTTP-01 challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Redirect all other HTTP to HTTPS
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name ${domain};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Published pages — public, no auth
    location /p/ {
        proxy_pass http://127.0.0.1:${AGENT_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    # All other requests → 404 (don't expose agent API on custom domains)
    location / {
        return 404;
    }
}
NGINX

  echo "✓ Wrote $conf"

  # Enable if not already
  local enabled="/etc/nginx/sites-enabled/${domain}.conf"
  if [ ! -L "$enabled" ]; then
    ln -s "$conf" "$enabled"
    echo "✓ Enabled $domain"
  fi
}

# Write configs (HTTP only first, for certbot to work)
for domain in "${DOMAINS[@]}"; do
  echo ""
  echo "=== Setting up $domain ==="

  # Write without SSL block first (certbot needs HTTP to work)
  local_conf="/etc/nginx/sites-available/${domain}.conf"
  cat > "$local_conf" <<NGINX_HTTP
server {
    listen 80;
    server_name ${domain};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
NGINX_HTTP

  ln -sf "$local_conf" "/etc/nginx/sites-enabled/${domain}.conf"
done

# Reload nginx to pick up new HTTP configs
nginx -t && nginx -s reload
echo "✓ nginx reloaded (HTTP configs active)"

# Get SSL certs
for domain in "${DOMAINS[@]}"; do
  echo ""
  echo "=== Requesting SSL cert for $domain ==="

  # Check if cert already exists
  if [ -f "/etc/letsencrypt/live/${domain}/fullchain.pem" ]; then
    echo "  Cert already exists — skipping certbot"
  else
    certbot certonly \
      --webroot -w /var/www/html \
      --non-interactive \
      --agree-tos \
      --email vova@recruiter-assistant.ru \
      -d "$domain" \
      || { echo "  ✗ certbot failed for $domain — is the DNS A record set?"; continue; }
    echo "  ✓ SSL cert obtained"
  fi

  # Now write full config with SSL
  write_nginx_config "$domain"
done

# Final reload with HTTPS configs
nginx -t && nginx -s reload
echo ""
echo "✓ Done! Domains configured:"
for domain in "${DOMAINS[@]}"; do
  echo "  https://${domain}/p/{slug}"
done

echo ""
echo "Next: set per-profile domain in the agent session:"
echo "  set_publish_domain('https://report.recruiter-assistant.ru')  # recruiter profile"
echo "  set_publish_domain('https://flexi-consult.manager-assistant.ru')  # flexi profile"
