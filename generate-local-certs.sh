#!/bin/bash
# Generate self-signed TLS certificates for local development
# Usage: ./generate-local-certs.sh

set -e

CERT_DIR="./certs"
DOMAIN="shop.local"
DAYS_VALID=365

# Create certificates directory
mkdir -p "$CERT_DIR"

echo "Generating self-signed TLS certificates for $DOMAIN..."

# Generate private key
openssl genrsa -out "$CERT_DIR/${DOMAIN}.key" 2048

# Generate certificate signing request (CSR)
openssl req -new \
  -key "$CERT_DIR/${DOMAIN}.key" \
  -out "$CERT_DIR/${DOMAIN}.csr" \
  -subj "/C=US/ST=CA/L=Local/O=CardMint/CN=${DOMAIN}"

# Generate self-signed certificate
openssl x509 -req \
  -in "$CERT_DIR/${DOMAIN}.csr" \
  -signkey "$CERT_DIR/${DOMAIN}.key" \
  -out "$CERT_DIR/${DOMAIN}.crt" \
  -days "$DAYS_VALID" \
  -extfile <(printf "subjectAltName=DNS:${DOMAIN},DNS:*.${DOMAIN}")

# Remove CSR (no longer needed)
rm "$CERT_DIR/${DOMAIN}.csr"

# Set appropriate permissions
chmod 600 "$CERT_DIR/${DOMAIN}.key"
chmod 644 "$CERT_DIR/${DOMAIN}.crt"

echo "✓ Self-signed TLS certificates generated successfully"
echo ""
echo "Certificate Details:"
echo "  Domain:     $DOMAIN"
echo "  Key file:   $CERT_DIR/${DOMAIN}.key"
echo "  Cert file:  $CERT_DIR/${DOMAIN}.crt"
echo "  Valid for:  $DAYS_VALID days"
echo ""
echo "Next steps:"
echo "  1. Add to /etc/hosts: 127.0.0.1 $DOMAIN"
echo "  2. Start Docker: docker-compose -f docker-compose.evershop.yml up -d"
echo "  3. Import certificate to browser (for local testing)"
echo ""
echo "Browser warning expected: certificate is self-signed"
echo "This is normal for local development."
