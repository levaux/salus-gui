#!/usr/bin/env bash
# gen-cert.sh — a dev certificate for the bridge.
#
# mkcert is preferred: it installs a local CA, so the browser trusts the cert
# with no interstitial. Without mkcert we fall back to self-signed openssl,
# which works identically on the wire — the browser just complains once, and
# you accept it.
#
# Both paths cover localhost + 127.0.0.1 + ::1 so the console can be reached by
# name or address.
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
mkdir -p "$dir"

if command -v mkcert >/dev/null 2>&1; then
  echo "mkcert found — issuing a locally-trusted certificate"
  mkcert -install >/dev/null 2>&1 || true
  mkcert -key-file "$dir/bridge-key.pem" -cert-file "$dir/bridge.pem" \
    localhost 127.0.0.1 ::1
else
  echo "mkcert not found — falling back to self-signed openssl"
  echo "  (the browser will warn once; 'brew install mkcert' avoids that)"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$dir/bridge-key.pem" \
    -out "$dir/bridge.pem" \
    -days 825 \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" \
    2>/dev/null
fi

chmod 600 "$dir/bridge-key.pem"
echo "wrote $dir/bridge.pem and bridge-key.pem"
