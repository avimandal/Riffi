#!/usr/bin/env bash
# Pre-flight check for the FTPS deploy. Explains *why* a connection would fail
# (Cloudflare-proxied host name, port blocked, FTPS not offered, bad login,
# missing folder) in plain words, without printing any secret.
#
# Inputs (environment): FTP_SERVER, FTP_USERNAME, FTP_PASSWORD, FTP_SERVER_DIR,
# FTP_PROTOCOL (ftps | ftps-legacy | ftp, default ftps), FTP_PORT (default 21 or 990),
# FTP_TLS_SECURITY (strict | loose, default strict; loose accepts a certificate
# that doesn't match the host name, still encrypted).
#
# GitHub masks secret values in logs, so the host name shows as ***; IP
# addresses, ports, protocol and FTP reply codes are not secrets and are shown.
set -uo pipefail

PROTOCOL="${FTP_PROTOCOL:-ftps}"
case "$PROTOCOL" in
  ftps) DEFAULT_PORT=21 ;;
  ftps-legacy) DEFAULT_PORT=990 ;;
  ftp) DEFAULT_PORT=21 ;;
  *) echo "::error title=Deploy settings::FTP_PROTOCOL must be ftps, ftps-legacy or ftp (got '$PROTOCOL')."; exit 1 ;;
esac
PORT="${FTP_PORT:-$DEFAULT_PORT}"
HOST="${FTP_SERVER:-}"
TIMEOUT=10
problems=0

say() { echo "  $*"; }
fail() { # title, message
  echo "::error title=$1::$2"
  problems=$((problems + 1))
}

echo "== Deploy settings"
for v in FTP_SERVER FTP_USERNAME FTP_PASSWORD FTP_SERVER_DIR; do
  if [ -n "${!v:-}" ]; then say "$v: set"; else say "$v: MISSING"; fi
done
SECURITY="${FTP_TLS_SECURITY:-strict}"
say "protocol: $PROTOCOL   port: $PORT   TLS certificate check: $SECURITY"
if [ -z "$HOST" ] || [ -z "${FTP_USERNAME:-}" ] || [ -z "${FTP_PASSWORD:-}" ]; then
  fail "Missing secret" "FTP_SERVER, FTP_USERNAME and FTP_PASSWORD must all be set under Settings → Secrets and variables → Actions."
  exit 1
fi
if [[ "$HOST" == *"://"* || "$HOST" == */* || "$HOST" == *:* ]]; then
  fail "FTP_SERVER format" "FTP_SERVER must be a bare host name like ftp.example.com: no ftp:// or ftps://, no path, no :port (set the port with the FTP_PORT variable)."
fi

echo "== DNS"
mapfile -t IPV4 < <(getent ahostsv4 "$HOST" 2>/dev/null | awk '{print $1}' | sort -u)
if [ ${#IPV4[@]} -eq 0 ]; then
  fail "DNS" "The FTP host name doesn't resolve to any IPv4 address. Check FTP_SERVER for typos."
  exit 1
fi
say "resolves to: ${IPV4[*]}"

# Cloudflare's published IPv4 ranges (https://www.cloudflare.com/ips-v4/), with a built-in copy if offline.
CF_RANGES=$(curl -fsS --max-time 5 https://www.cloudflare.com/ips-v4/ 2>/dev/null || true)
if [ -z "$CF_RANGES" ]; then
  CF_RANGES="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
fi
in_cloudflare() {
  python3 - "$1" $CF_RANGES <<'PY'
import ipaddress, sys
ip = ipaddress.ip_address(sys.argv[1])
sys.exit(0 if any(ip in ipaddress.ip_network(r.strip()) for r in sys.argv[2:] if r.strip()) else 1)
PY
}
cloudflare=0
for ip in "${IPV4[@]}"; do
  if in_cloudflare "$ip"; then cloudflare=1; say "$ip is a Cloudflare proxy address"; fi
done
if [ $cloudflare -eq 1 ]; then
  fail "FTP host is behind Cloudflare's proxy" "FTP_SERVER points at Cloudflare (orange cloud). Cloudflare only proxies web traffic, so FTP can never connect through it. Use a host name that goes straight to your hosting server: your host's server name from the control panel (e.g. serverNN.yourhost.com), or a DNS record such as ftp.avimandal.com set to 'DNS only' (grey cloud) in Cloudflare."
  exit 1
fi

echo "== Connection to port $PORT"
ip="${IPV4[0]}"
if timeout "$TIMEOUT" bash -c "exec 3<>/dev/tcp/$ip/$PORT" 2>/dev/null; then
  say "TCP connection to $ip:$PORT: OK"
else
  fail "Can't reach port $PORT" "Nothing answered on $ip:$PORT within ${TIMEOUT}s. Either the host name is wrong (see DNS above), the server uses a different port, or its firewall blocks GitHub's runners (ask your host to allow FTP from anywhere, or from GitHub Actions' IP ranges)."
  for p in 21 990 22; do
    [ "$p" = "$PORT" ] && continue
    if timeout 5 bash -c "exec 3<>/dev/tcp/$ip/$p" 2>/dev/null; then say "port $p on $ip is open"; else say "port $p on $ip: no answer"; fi
  done
  say "(port 21 = FTP/explicit FTPS, 990 = implicit FTPS, 22 = SFTP, which this workflow doesn't use)"
  exit 1
fi

if [ "$PROTOCOL" != "ftps-legacy" ]; then
  banner=$(timeout "$TIMEOUT" bash -c "exec 3<>/dev/tcp/$ip/$PORT; read -r -t $TIMEOUT line <&3; echo \"\$line\"" 2>/dev/null | tr -d '\r' || true)
  code="${banner:0:3}"
  if [ "$code" = "220" ]; then say "FTP greeting: 220 (server is speaking FTP)"; else
    fail "Not an FTP server" "Port $PORT answered but didn't greet like an FTP server (reply '${code:-nothing}'). Check FTP_SERVER and FTP_PORT."
    exit 1
  fi
fi

echo "== TLS and login"
case "$PROTOCOL" in
  ftps) URL="ftp://$HOST:$PORT/"; TLS=(--ssl-reqd) ;;
  ftps-legacy) URL="ftps://$HOST:$PORT/"; TLS=() ;;
  ftp) URL="ftp://$HOST:$PORT/"; TLS=() ;;
esac
[ "$SECURITY" = "loose" ] && [ "$PROTOCOL" != "ftp" ] && TLS+=(--insecure)
DIR="${FTP_SERVER_DIR:-./}"
DIR="${DIR#./}"
DIR="${DIR#/}"
NETRC=$(mktemp)
chmod 600 "$NETRC"
printf 'machine %s login %s password %s\n' "$HOST" "$FTP_USERNAME" "$FTP_PASSWORD" > "$NETRC"
trap 'rm -f "$NETRC"' EXIT
# List the target folder: proves TLS, the login and the folder in one go.
out=$(curl -sS --max-time 30 --ftp-pasv "${TLS[@]}" --netrc-file "$NETRC" --list-only "$URL${DIR:+$DIR/}" -o /dev/null -w '%{response_code}' 2>&1)
rc=$?
last="${out: -3}"
case $rc in
  0) say "TLS: OK   login: OK   folder: OK (reply $last)" ;;
  64) fail "Server doesn't offer FTPS" "The server refused to switch to TLS on port $PORT. If your host only supports implicit FTPS, set repository variables FTP_PROTOCOL=ftps-legacy and FTP_PORT=990. Plain FTP (FTP_PROTOCOL=ftp) sends the password unencrypted, so avoid it." ;;
  35 | 60) fail "TLS certificate problem" "TLS started, but the server's certificate isn't valid for the FTP host name (curl error $rc). Use the host name the certificate was issued for, usually your host's server name (e.g. serverNN.yourhost.com) rather than your own domain. If your host only gives you a certificate for another name, set the repository variable FTP_TLS_SECURITY=loose (still encrypted, but the name isn't checked)." ;;
  67) fail "FTP login rejected" "The server rejected FTP_USERNAME/FTP_PASSWORD (reply 530). Re-copy them from your hosting control panel. Many hosts need the full username, e.g. deploy@avimandal.com." ;;
  9 | 78) fail "Upload folder not found" "Logged in, but the folder in FTP_SERVER_DIR doesn't exist. Since the FTP account already starts at the site root, set FTP_SERVER_DIR to ./" ;;
  28) fail "Timed out during TLS/login" "The server accepted the connection but stopped responding (curl error 28). This is often a firewall blocking passive-mode data ports; ask your host to check passive FTP." ;;
  *) fail "FTP check failed" "curl error $rc (last reply ${last:-none}). See https://curl.se/libcurl/c/libcurl-errors.html" ;;
esac

if [ $problems -gt 0 ]; then
  echo "== $problems problem(s) found: not uploading."
  exit 1
fi
echo "== All checks passed"
