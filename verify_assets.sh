# Verification Script
#\!/bin/bash
echo 'Verifying CardMint assets...'
if [ -f data/cardmint_dev.db ]; then
  echo '✓ cardmint_dev.db found'
  sha256sum data/cardmint_dev.db
else
  echo '✗ cardmint_dev.db missing'
fi
