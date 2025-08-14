#!/bin/bash

echo "Fixing PostgreSQL permissions for CardMint..."
echo "============================================="
echo
echo "This will grant the cardmint user necessary permissions."
echo "You'll need to enter your sudo password."
echo

# Grant schema permissions
sudo -u postgres psql -d cardmint << EOF
-- Grant all privileges on the database
GRANT ALL PRIVILEGES ON DATABASE cardmint TO cardmint;

-- Grant schema permissions
GRANT ALL ON SCHEMA public TO cardmint;
GRANT CREATE ON SCHEMA public TO cardmint;

-- Grant default privileges for future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO cardmint;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO cardmint;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO cardmint;

-- Make cardmint the owner of the public schema
ALTER SCHEMA public OWNER TO cardmint;

-- Confirm permissions
\dn+
EOF

echo
echo "Testing permissions by creating a test table..."

export PGPASSWORD=changeme
psql -h localhost -U cardmint -d cardmint << EOF
-- Test table creation
CREATE TABLE IF NOT EXISTS permission_test (id SERIAL PRIMARY KEY, test VARCHAR(50));
DROP TABLE IF EXISTS permission_test;
SELECT 'Permissions configured successfully!' as status;
EOF

if [ $? -eq 0 ]; then
    echo
    echo "✓ Permissions fixed successfully!"
    echo "You can now start CardMint with: ./start.sh"
else
    echo
    echo "✗ Failed to configure permissions. Please check the error messages above."
fi