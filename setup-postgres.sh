#!/bin/bash

echo "Setting up PostgreSQL for CardMint..."
echo "This script will configure PostgreSQL to use password authentication."
echo "You will need to enter your sudo password."
echo

# Configure pg_hba.conf for password authentication
sudo sed -i 's/ident/md5/g' /var/lib/pgsql/data/pg_hba.conf

# Reload PostgreSQL
sudo systemctl reload postgresql

echo "PostgreSQL configuration updated."
echo "Testing connection..."

# Test connection
export PGPASSWORD=changeme
psql -h localhost -U cardmint -d cardmint -c "SELECT 'Database connection successful!' as status;" 2>&1

if [ $? -eq 0 ]; then
    echo "✓ PostgreSQL is configured correctly!"
else
    echo "✗ Connection failed. Please check your PostgreSQL configuration."
fi